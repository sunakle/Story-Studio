// Низкоуровневый DSP для озвучки реплик.
//
// Порт движка Dialogue Voice Studio (C++/JUCE) на чистый JS: те же узлы, та же
// топология цепочки, те же формулы огибающих и модуляций. Работает и в окне
// (Web Audio), и в node (OfflineAudioContext не нужен — считаем сэмплы сами),
// поэтому движок можно проверять тестами без запуска приложения.

export const TAU = Math.PI * 2;

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const db = (x) => Math.pow(10, x * 0.05);

/** Детерминированный шум: ровно тот же линейный конгруэнтный генератор, что в плагине. */
export class Noise {
  constructor(seed = 1) {
    this.state = seed >>> 0 || 1;
  }
  next() {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return (this.state >>> 8) / 8388608 - 1;
  }
}

/**
 * Биквадратный фильтр (transposed direct form II) — как в JUCE IIRFilter.
 * Коэффициенты считаются по RBJ cookbook: АЧХ совпадает с плагином.
 */
export class Biquad {
  constructor() {
    this.b0 = 1;
    this.b1 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
    this.z1 = 0;
    this.z2 = 0;
  }

  reset() {
    this.z1 = 0;
    this.z2 = 0;
  }

  _set(b0, b1, b2, a0, a1, a2) {
    const inv = 1 / a0;
    this.b0 = b0 * inv;
    this.b1 = b1 * inv;
    this.b2 = b2 * inv;
    this.a1 = a1 * inv;
    this.a2 = a2 * inv;
    return this;
  }

  lowPass(rate, freq, q) {
    const f = clamp(freq, 5, rate * 0.47);
    const w = (TAU * f) / rate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(0.05, q));
    const b1 = 1 - cos;
    return this._set(b1 / 2, b1, b1 / 2, 1 + alpha, -2 * cos, 1 - alpha);
  }

  highPass(rate, freq, q) {
    const f = clamp(freq, 5, rate * 0.47);
    const w = (TAU * f) / rate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(0.05, q));
    const b1 = -(1 + cos);
    return this._set((1 + cos) / 2, b1, (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
  }

  bandPass(rate, freq, q) {
    const f = clamp(freq, 5, rate * 0.47);
    const w = (TAU * f) / rate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(0.05, q));
    return this._set(alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha);
  }

  peaking(rate, freq, q, gainDb) {
    const f = clamp(freq, 5, rate * 0.47);
    const A = Math.pow(10, gainDb / 40);
    const w = (TAU * f) / rate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(0.05, q));
    return this._set(1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A);
  }

  lowShelf(rate, freq, q, gainDb) {
    const f = clamp(freq, 5, rate * 0.47);
    const A = Math.pow(10, gainDb / 40);
    const w = (TAU * f) / rate;
    const cos = Math.cos(w);
    const sn = Math.sin(w);
    const alpha = (sn / 2) * Math.sqrt((A + 1 / A) * (1 / Math.max(0.05, q) - 1) + 2);
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
    return this._set(
      A * (A + 1 - (A - 1) * cos + twoSqrtAAlpha),
      2 * A * (A - 1 - (A + 1) * cos),
      A * (A + 1 - (A - 1) * cos - twoSqrtAAlpha),
      A + 1 + (A - 1) * cos + twoSqrtAAlpha,
      -2 * (A - 1 + (A + 1) * cos),
      A + 1 + (A - 1) * cos - twoSqrtAAlpha,
    );
  }

  highShelf(rate, freq, q, gainDb) {
    const f = clamp(freq, 5, rate * 0.47);
    const A = Math.pow(10, gainDb / 40);
    const w = (TAU * f) / rate;
    const cos = Math.cos(w);
    const sn = Math.sin(w);
    const alpha = (sn / 2) * Math.sqrt((A + 1 / A) * (1 / Math.max(0.05, q) - 1) + 2);
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
    return this._set(
      A * (A + 1 + (A - 1) * cos + twoSqrtAAlpha),
      -2 * A * (A - 1 + (A + 1) * cos),
      A * (A + 1 + (A - 1) * cos - twoSqrtAAlpha),
      A + 1 - (A - 1) * cos + twoSqrtAAlpha,
      2 * (A - 1 - (A + 1) * cos),
      A + 1 - (A - 1) * cos - twoSqrtAAlpha,
    );
  }

  tick(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Полоса семиполосного эквалайзера: 0 — HP, 6 — LP, 1 и 5 — полки, между — пики. */
export function setBand(biquad, index, rate, freq, q, gainDb) {
  if (index === 0) return biquad.highPass(rate, freq, q);
  if (index === 6) return biquad.lowPass(rate, freq, q);
  if (index === 1) return biquad.lowShelf(rate, freq, q, gainDb);
  if (index === 5) return biquad.highShelf(rate, freq, q, gainDb);
  return biquad.peaking(rate, freq, q, gainDb);
}

/**
 * Форма волны осциллятора. Индексы совпадают с плагином:
 * 0 синус, 1 треугольник, 2 пила, 3 пульс, 4 шум,
 * 5 орган, 6 колокол FM, 7 ступенчатая пила, 8 тростниковый, 9 двойной импульс.
 */
export function waveform(index, phase, width, ageMs, noise) {
  switch (index) {
    case 0:
      return Math.sin(phase * TAU);
    case 1:
      return 1 - 4 * Math.abs(phase - 0.5);
    case 2:
      return 2 * phase - 1;
    case 3:
      return phase < width ? 1 : -1;
    case 5: {
      const a = phase * TAU;
      return (Math.sin(a) + 0.65 * Math.sin(2 * a) + 0.35 * Math.sin(4 * a)) * 0.5;
    }
    case 6: {
      const a = phase * TAU;
      return Math.sin(a + 3.4 * Math.exp(-ageMs / 75) * Math.sin(3 * a));
    }
    case 7:
      return (2 * Math.floor(phase * 8)) / 7 - 1;
    case 8: {
      const a = phase * TAU;
      return (Math.sin(a) + 0.6 * Math.sin(3 * a) + 0.4 * Math.sin(5 * a)) * 0.5;
    }
    case 9:
      return phase < 0.17 || (phase >= 0.47 && phase < 0.8) ? 1 : -1;
    default:
      return noise.next();
  }
}

/** Freeverb: 8 гребёнок + 4 всепропускающих на канал. */
export class Reverb {
  constructor() {
    this.setSampleRate(48000);
    this.roomSize = 0.42;
    this.damping = 0.48;
    this.wet = 0.054;
    this.dry = 0.42;
    this.width = 1;
    this._prepare();
  }

  setSampleRate(rate) {
    this.rate = rate;
    this._prepare();
  }

  setParameters({ roomSize, damping, wetLevel, dryLevel, width } = {}) {
    if (roomSize !== undefined) this.roomSize = roomSize;
    if (damping !== undefined) this.damping = damping;
    if (wetLevel !== undefined) this.wet = wetLevel;
    if (dryLevel !== undefined) this.dry = dryLevel;
    if (width !== undefined) this.width = width;
  }

  _prepare() {
    const scale = this.rate / 44100;
    const combTune = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
    const apTune = [556, 441, 341, 225];
    const spread = Math.round(23 * scale);
    this.combs = [];
    this.aps = [];
    for (let ch = 0; ch < 2; ++ch) {
      for (const t of combTune) {
        const len = Math.max(8, Math.round(t * scale) + (ch ? spread : 0));
        this.combs.push({ buf: new Float32Array(len), idx: 0, store: 0 });
      }
      for (const t of apTune) {
        const len = Math.max(4, Math.round(t * scale) + (ch ? spread : 0));
        this.aps.push({ buf: new Float32Array(len), idx: 0 });
      }
    }
    this.perChannel = combTune.length;
  }

  reset() {
    for (const c of this.combs) {
      c.buf.fill(0);
      c.idx = 0;
      c.store = 0;
    }
    for (const a of this.aps) {
      a.buf.fill(0);
      a.idx = 0;
    }
  }

  _comb(c, input, feedback, damp) {
    const out = c.buf[c.idx];
    c.store = out * (1 - damp) + c.store * damp;
    c.buf[c.idx] = input + c.store * feedback;
    c.idx = (c.idx + 1) % c.buf.length;
    return out;
  }

  _allpass(a, input) {
    const buffered = a.buf[a.idx];
    a.buf[a.idx] = input + buffered * 0.5;
    a.idx = (a.idx + 1) % a.buf.length;
    return buffered - input;
  }

  processStereo(left, right) {
    const feedback = 0.7 + this.roomSize * 0.28;
    const damp = this.damping * 0.4;
    const input = (left + right) * 0.015;
    const out = [0, 0];
    for (let ch = 0; ch < 2; ++ch) {
      let acc = 0;
      const base = ch * this.perChannel;
      for (let k = 0; k < this.perChannel; ++k) acc += this._comb(this.combs[base + k], input, feedback, damp);
      for (let k = 0; k < 4; ++k) acc = this._allpass(this.aps[ch * 4 + k], acc);
      out[ch] = acc;
    }
    const wet1 = this.wet * (this.width / 2 + 0.5);
    const wet2 = this.wet * ((1 - this.width) / 2);
    return [
      left * this.dry + out[0] * wet1 + out[1] * wet2,
      right * this.dry + out[1] * wet1 + out[0] * wet2,
    ];
  }
}

/** Коэффициенты одной полосы эквалайзера — как в цепочке Engine. */
export function bandCoeffs(params, index, rate) {
  const id = 'b' + index;
  const q = params[id + 'q'] || 0.71;
  const freq = params[id + 'freq'] || 1000;
  const gain = index === 0 || index === 6 ? 0 : params[id + 'gain'] || 0;
  return setBand(new Biquad(), index, rate, freq, q, gain);
}

/**
 * АЧХ эквалайзера в децибелах на частоте freq — сумма модулей всех включённых полос.
 * Нужна для кривой на вкладке EQ (в плагине считается так же, по коэффициентам).
 */
export function eqResponseDb(params, freq, rate = 48000) {
  if (!params || !params.eq) return 0;
  const f = clamp(freq, 10, rate * 0.49);
  const w = (TAU * f) / rate;
  const zr = Math.cos(-w);
  const zi = Math.sin(-w);
  const z2r = Math.cos(-2 * w);
  const z2i = Math.sin(-2 * w);
  let mag = 1;
  for (let k = 0; k < 7; ++k) {
    if (!params['b' + k + 'on']) continue;
    const b = bandCoeffs(params, k, rate);
    const numR = b.b0 + b.b1 * zr + b.b2 * z2r;
    const numI = b.b1 * zi + b.b2 * z2i;
    const denR = 1 + b.a1 * zr + b.a2 * z2r;
    const denI = b.a1 * zi + b.a2 * z2i;
    const den = Math.hypot(denR, denI);
    if (den > 1e-12) mag *= Math.hypot(numR, numI) / den;
  }
  return 20 * Math.log10(Math.max(1e-6, mag));
}
