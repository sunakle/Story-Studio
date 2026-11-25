import { t } from '../i18n.js';
// Движок синтеза реплики: порт Engine.h + Render.h из Dialogue Voice Studio.
//
// Одна «реплика» — это последовательность импульсов (слогов): на каждую N-ю
// букву запускается голос с небольшим случайным разбросом высоты и громкости,
// точки и запятые добавляют паузы. Дальше сигнал проходит ту же цепочку, что в
// плагине: огибающая → фильтр → эквалайзер → биткрашер → сатурация → фолдер →
// кольцевая модуляция → тремоло → компрессор → задержка → реверберация → панорама.

import { Biquad, Noise, Reverb, clamp, db, setBand, waveform, TAU } from './dsp.js';
import { resolveParams } from './params.js';

const VOICES = 24;
const MAX_SECONDS = 90;

const isLetter = (code) => {
  const ch = String.fromCharCode(code);
  return /[\p{L}\p{N}]/u.test(ch);
};

export class Engine {
  constructor(rate = 48000) {
    this.rate = rate;
    this.params = resolveParams(null);
    this.sample = null;
    this.fullSample = false;
    this.voices = Array.from({ length: VOICES }, () => this._newVoice());
    this.slot = 0;
    this.last = -1;
    this.osc = [
      { wave: 3, level: 0.64, ratio: 1, width: 0.34 },
      { wave: 1, level: 0.22, ratio: 0.5, width: 0.34 },
    ];
    this.eq = Array.from({ length: 7 }, () => new Biquad());
    this.eqActive = new Array(7).fill(false);
    this.filter = new Biquad();
    this.verb = new Reverb();
    this.verb.setSampleRate(rate);
    this.line = new Float32Array(Math.ceil(rate) + 2);
    this.head = 0;
    this.delayFrames = 1;
    this.crushPhase = 1;
    this.held = 0;
    this.env = 0;
    this.atk = 0.5;
    this.rel = 0.99;
    this.quant = 128;
    this.amp = 1;
    this.leftGain = 1;
    this.rightGain = 1;
    this.driveGain = 1;
    this.ringPhase = 0;
    this.tremPhase = 0;
    this.begin = 0;
    this.finish = 0;
  }

  _newVoice() {
    return {
      active: false,
      releasing: false,
      note: 60,
      age: 0,
      releaseAge: 0,
      p: [0, 0],
      pos: 0,
      from: 0,
      target: 0,
      vel: 1,
      held: 0,
      noise: new Noise(1),
    };
  }

  configure(params, sample = null, audition = false) {
    if (this.sample !== sample) {
      for (const v of this.voices) v.active = false;
    }
    this.params = params;
    this.sample = sample;
    this.fullSample = audition;
    const p = params;

    for (let k = 0; k < 2; ++k) {
      const id = `osc${k + 1}`;
      const extra = Math.round(p[`${id}extra`] || 0);
      this.osc[k] = {
        wave: extra ? 4 + extra : Math.round(p[`${id}wave`] || 0),
        level: (p[`${id}level`] || 0) * 0.01,
        ratio: Math.pow(2, (p[`${id}oct`] || 0) + (p[`${id}fine`] || 0) / 1200),
        width: (p[`${id}width`] || 34) * 0.01,
      };
    }

    for (let k = 0; k < 7; ++k) {
      const id = `b${k}`;
      this.eqActive[k] = !!p.eq && !!p[`${id}on`];
      this.eq[k].reset();
      setBand(this.eq[k], k, this.rate, p[`${id}freq`], p[`${id}q`], k === 0 || k === 6 ? 0 : p[`${id}gain`] || 0);
    }

    this.filter.reset();
    const cutoff = Math.min(this.rate * 0.47, p.cutoff);
    const res = p.res;
    if (p.filterType === 1) this.filter.highPass(this.rate, cutoff, res);
    else if (p.filterType === 2) this.filter.bandPass(this.rate, cutoff, res);
    else this.filter.lowPass(this.rate, cutoff, res);

    this.verb.setParameters({
      roomSize: (p.room || 0) * 0.01,
      damping: (p.damp || 0) * 0.01,
      wetLevel: ((p.revMix || 0) * 0.01) * 0.34,
      dryLevel: (1 - (p.revMix || 0) * 0.01) * 0.5,
      width: 1,
    });

    this.delayFrames = clamp(Math.round((p.delayMs || 0) * this.rate * 0.001), 1, this.line.length - 1);
    this.quant = Math.pow(2, (p.bits || 8) - 1);
    this.driveGain = db(p.drive || 0);
    this.amp = db(p.out || 0);
    this.atk = Math.exp(-1000 / (Math.max(0.2, p.compAtk || 6) * this.rate));
    this.rel = Math.exp(-1000 / (Math.max(5, p.compRel || 90) * this.rate));
    const angle = ((p.pan || 0) * 0.01 + 1) * Math.PI * 0.25;
    this.leftGain = Math.cos(angle) * 1.4142;
    this.rightGain = Math.sin(angle) * 1.4142;

    if (sample) {
      const count = sample.pcm.length;
      this.begin = clamp(Math.floor((count * (p.start || 0)) / 100), 0, count - 1);
      this.finish = clamp(Math.floor((count * (p.end == null ? 100 : p.end)) / 100), this.begin + 1, count);
    }
  }

  on(note, velocity, seed) {
    const v = this.voices[this.slot % VOICES];
    this.slot = (this.slot + 1) % VOICES;
    Object.assign(v, this._newVoice());
    v.active = true;
    v.note = Math.round(note);
    v.target = note + this.params.pitch;
    v.from = this.last < 0 ? v.target : this.last;
    this.last = v.target;
    v.vel = velocity;
    v.noise.state = (seed >>> 0) || 1;
  }

  release(v) {
    if (!v.releasing) {
      v.releasing = true;
      v.releaseAge = 0;
    }
  }

  _voice(v) {
    const p = this.params;
    const t = (v.age * 1000) / this.rate;
    const glide = p.glide > 0 ? Math.max(0, 1 - t / p.glide) : 0;
    const note =
      v.target +
      (v.from - v.target) * glide +
      (p.vib || 0) * 0.01 * Math.sin(t * 0.001 * (p.vibRate || 6) * TAU);
    const freq = 440 * Math.pow(2, (note - 69) / 12);

    let synth = 0;
    let sampleValue = 0;
    for (let k = 0; k < 2; ++k) {
      const o = this.osc[k];
      const phase = v.p[k];
      synth += waveform(o.wave, phase, o.width, t, v.noise) * o.level;
      v.p[k] = (phase + Math.min(0.48, (freq * o.ratio) / this.rate)) % 1;
    }

    const clip = this.sample;
    if (clip && v.pos < this.finish - this.begin) {
      const step =
        (clip.rate / this.rate) * Math.pow(2, (note - 60 + (p.samplePitch || 0) + (p.sampleFine || 0) * 0.01) / 12);
      const loc = clamp(p.reverse ? this.finish - 1 - v.pos : this.begin + v.pos, this.begin, this.finish - 1);
      const i = Math.floor(loc);
      const a = clip.pcm[i];
      const b = clip.pcm[Math.min(this.finish - 1, i + 1)];
      sampleValue = a + (loc - i) * (b - a);
      if (p.normalize) sampleValue /= Math.max(0.000001, clip.peak);
      const remaining = ((this.finish - this.begin - v.pos) / step) * 1000 / this.rate;
      sampleValue *=
        Math.min(1, t / Math.max(0.001, p.fadeIn || 0.001)) *
        Math.min(1, remaining / Math.max(0.001, p.fadeOut || 0.001));
      v.pos += step;
    }

    if (this.fullSample && (!clip || v.pos >= this.finish - this.begin)) v.active = false;
    if (!this.fullSample && t >= p.duration) this.release(v);

    let envelope = 1;
    if (!this.fullSample) {
      if (v.releasing) {
        envelope = v.held * Math.max(0, 1 - (v.releaseAge * 1000) / (this.rate * Math.max(0.001, p.release)));
        if (++v.releaseAge >= (this.rate * p.release) / 1000) v.active = false;
      } else {
        envelope =
          t < p.attack
            ? t / p.attack
            : 1 + ((p.sustain || 0) * 0.01 - 1) * Math.min(1, (t - p.attack) / Math.max(0.001, p.decay));
        v.held = envelope;
      }
    }

    ++v.age;
    const blend = this.fullSample || p.source === 1 ? 1 : p.source === 0 ? 0 : (p.blend || 0) * 0.01;
    return ((1 - blend) * synth + blend * sampleValue) * envelope * v.vel;
  }

  tick() {
    const p = this.params;
    let x = 0;
    for (const v of this.voices) if (v.active) x += this._voice(v);

    if (p.filter) x = this.filter.tick(x);
    for (let k = 0; k < 7; ++k) if (this.eqActive[k]) x = this.eq[k].tick(x);

    if (p.crush) {
      this.crushPhase += Math.min(1, (p.crushRate || 12000) / this.rate);
      if (this.crushPhase >= 1) {
        this.crushPhase -= 1;
        this.held = Math.round(x * this.quant) / this.quant;
      }
      x = this.held;
    }

    if (p.sat) x = Math.tanh(x * this.driveGain) / Math.tanh(this.driveGain);

    if (p.fold) {
      const amt = p.foldAmt || 4;
      const folded = 1 - Math.abs(((Math.abs(x * amt + 1) % 4) + 4) % 4 - 2);
      x += (folded - x) * ((p.foldMix || 0) * 0.01);
    }

    if (p.ring) {
      x *= 1 + (p.ringMix || 0) * 0.01 * (Math.cos(this.ringPhase * TAU) - 1);
      this.ringPhase += (p.carrier || 135) / this.rate;
      this.ringPhase -= Math.floor(this.ringPhase);
    }

    if (p.trem) {
      x *= 1 - (p.tremDepth || 0) * 0.005 * (1 - Math.cos(this.tremPhase * TAU));
      this.tremPhase += (p.tremRate || 12) / this.rate;
      this.tremPhase -= Math.floor(this.tremPhase);
    }

    if (p.comp) {
      const a = Math.abs(x) > this.env ? this.atk : this.rel;
      this.env = a * this.env + (1 - a) * Math.abs(x);
      const above = Math.max(0, 20 * Math.log10(Math.max(1e-9, this.env)) - (p.threshold || 0));
      x *= db(-above * (1 - 1 / Math.max(1, p.ratio || 1)));
    }

    if (p.delay) {
      const d = this.line[(this.head + this.line.length - this.delayFrames) % this.line.length];
      this.line[this.head] = x + d * ((p.feedback || 0) * 0.01);
      this.head = (this.head + 1) % this.line.length;
      x += (d - x) * ((p.delayMix || 0) * 0.01);
    }

    let left = x;
    let right = x;
    if (p.reverb) [left, right] = this.verb.processStereo(left, right);
    return [left * this.amp * this.leftGain, right * this.amp * this.rightGain];
  }
}

/**
 * Рендер реплики.
 * mode: 'line' — по тексту, 'pulse' — один слог, 'variation' — один слог с разбросом,
 * 'selection' — проиграть выделенный кусок сэмпла целиком (как в плагине).
 * Возвращает { left, right, rate, text, reveal, seconds }.
 */
export function renderLine(options) {
  const job = renderBlocks(options);
  let block = job.next();
  while (!block.done) block = job.next();
  return block.value;
}

export function* renderBlocks({ params, sample = null, text = '', seed = 1, mode = 'line' }) {
  const voice = resolveParams(params);
  const rate = 48000;
  const engine = new Engine(rate);
  engine.configure(voice, sample, mode === 'selection');

  const rnd = new Noise(seed);
  const hits = [];
  const push = (frame, vary) => {
    const p = rnd.next();
    const v = rnd.next();
    hits.push({
      frame,
      note: 60 + (vary ? p * voice.spread : 0),
      velocity: 1 + (vary ? v * voice.jitter * 0.01 : 0),
      seed: rnd.state,
    });
  };

  const reveal = [];
  let cursor = 0;
  const clean = String(text || '');

  if (mode === 'line') {
    let letters = 0;
    for (let i = 0; i < clean.length; ++i) {
      const ch = clean[i];
      reveal.push(Math.round(cursor));
      let ms = 1000 / voice.speed;
      if (ch === '…') {
        ms += voice.ellipsis;
      } else if (ch === '.' && clean.slice(i, i + 3) === '...') {
        reveal.push(Math.round(cursor), Math.round(cursor));
        i += 2;
        ms += voice.ellipsis;
      } else if (ch === '.' || ch === '!' || ch === '?') {
        ms += voice.period;
      } else if (ch === ',' || ch === ';' || ch === ':' || ch === '\n') {
        ms += voice.comma;
      } else if (isLetter(ch.charCodeAt(0)) && letters++ % Math.max(1, Math.round(voice.every)) === 0) {
        push(Math.round(cursor), true);
      }
      cursor += ms * 0.001 * rate;
      if (cursor > rate * MAX_SECONDS) {
        throw new Error(t('Реплика длиннее 90 секунд. Сократите текст или увеличьте скорость.', 'The line exceeds 90 seconds. Shorten the text or increase the speed.'));
      }
    }
  } else {
    push(0, mode === 'variation');
  }

  // Длительность импульса: обычная или (для выделения сэмпла) — длина выделения
  // после транспонирования, как в Render.h.
  let syllable = (voice.duration + voice.release + 5) * 0.001;
  if (mode === 'selection' && sample) {
    syllable =
      ((sample.pcm.length / sample.rate) * (voice.end - voice.start) * 0.01) /
        Math.pow(2, (voice.pitch + voice.samplePitch + voice.sampleFine * 0.01) / 12) +
      0.02;
  }
  if (syllable > MAX_SECONDS) {
    throw new Error(t('Выделение после транспонирования длиннее 90 секунд.', 'The transposed selection exceeds 90 seconds.'));
  }
  const dryEnd = Math.max(
    Math.round(cursor),
    hits.length ? hits[hits.length - 1].frame + Math.round(rate * syllable) : 1,
  );

  let tail = 0;
  if (voice.delay && voice.delayMix > 0) {
    const fb = voice.feedback * 0.01;
    tail += voice.delayMs * 0.001 * (fb > 0 ? 1 + Math.ceil(Math.log(0.00003) / Math.log(fb)) : 1);
  }
  if (voice.reverb && voice.revMix > 0) tail += 8;

  const n = dryEnd + Math.round((tail + 0.03) * rate);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let next = 0;
  let lastSignal = dryEnd;

  for (let i = 0; i < n; ++i) {
    if (i && (i & 4095) === 0) yield;
    while (next < hits.length && hits[next].frame === i) {
      const h = hits[next++];
      engine.on(h.note, h.velocity, h.seed);
    }
    const [l, r] = engine.tick();
    left[i] = l;
    right[i] = r;
    if (Math.abs(l) + Math.abs(r) > 0.00003) lastSignal = i;
  }

  const end = Math.min(n, Math.max(dryEnd, lastSignal + 64));
  return {
    left: left.subarray(0, end),
    right: right.subarray(0, end),
    rate,
    text: clean,
    reveal,
    seconds: end / rate,
  };
}

/** Пиковая амплитуда — для индикатора перегруза и нормализации. */
export function peakOf(rendered) {
  let peak = 0;
  for (let i = 0; i < rendered.left.length; ++i) {
    peak = Math.max(peak, Math.abs(rendered.left[i]), Math.abs(rendered.right[i]));
  }
  return peak;
}
