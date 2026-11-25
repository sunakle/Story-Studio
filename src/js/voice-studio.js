import { t as uiText, getLanguage } from './i18n.js';
// Студия голоса — полный интерфейс плагина Dialogue Voice Studio внутри StoryForge.
//
// Перенесено из Source/Editor.cpp и Source/Views.h один-в-один:
//   • портрет с «лицом», живой строкой и индикатором уровня;
//   • пять вкладок: Голос / Сэмпл / EQ / Эффекты / Диалог;
//   • верхний ряд (высота, импульс, скорость) и ряд действий
//     (один звук, озвучить реплику, стоп, повторить дубль, новый дубль);
//   • вкладка «Сэмпл»: волновая форма с выделением, зумом и перетаскиванием границ;
//   • вкладка «EQ»: кривая АЧХ из коэффициентов + живой спектр, 7 перетаскиваемых точек;
//   • вкладка «Диалог»: текст до 600 символов, частота/каналы/битность, три экспорта;
//   • сохранение и открытие голоса в .dvoice, перетаскивание WAV в окно.
//
// Отличия от плагина — только те, что даёт сама StoryForge: голос принадлежит
// персонажу (или проекту), текст берётся из выбранной реплики, а рендер идёт
// в модульном Worker с порционным резервным режимом.

import { icon } from './icons.js';
import {
  FACTORY_VOICES,
  MAIN_SPECS,
  TABS,
  diffFromPreset,
  factoryById,
  resolveParams,
  specById,
  specsForTab,
} from './voice/params.js';
import { eqResponseDb } from './voice/dsp.js';
import { synthesize } from './voice/job.js';
import { formatSeconds } from './voice/wav.js';
import { LINE_TARGET, clearSampleCache, effectiveVoice, packSample, sampleAudio, takeSeed, voiceOperation, voiceTarget } from './voice/profile.js';
import { openVoiceLibrary } from './voice-library.js';

const PORTRAIT_ART = [
  '  ##        ##  ',
  '  ####    ####  ',
  '  ############  ',
  ' ##  ######  ## ',
  '###          ###',
  '##   ##  ##   ##',
  '###  ##  ##  ###',
  ' ###        ### ',
  '  ####    ####  ',
  '   ### ## ###   ',
  '    ########    ',
  '   ##  ##  ##   ',
];

const RATES = [
  { id: 44100, get label() { return uiText("44,1 кГц", "44.1 kHz"); } },
  { id: 48000, get label() { return uiText("48 кГц", "48 kHz"); } },
];
const CHANNELS = [
  { id: 1, get label() { return uiText("Моно", "Mono"); } },
  { id: 2, get label() { return uiText("Стерео", "Stereo"); } },
];
const DEPTHS = [
  { id: 16, get label() { return uiText("16 бит", "16 bit"); } },
  { id: 24, get label() { return uiText("24 бита", "24 bits"); } },
];

const slug = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'voice';

const fmt = (value, spec) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  const step = spec ? spec.step : 1;
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return num.toFixed(digits);
};

export function createVoiceStudio({ root, store, ui }) {
  const state = {
    open: false,
    target: '',
    page: 0,
    nodeId: '',
    phrase: '',
    dir: '',
    sample: null,
    sampleName: '',
    zoom: 1,
    offset: 0,

    playing: null,
    exporting: false,
    compact: false,
    status: '',
    meter: 0,
    clip: 0,
    bins: new Float32Array(512).fill(-90),

  };

  let audio = null; // { ctx, analyser, data, spectrum }
  let raf = 0;
  let shellLanguage = null;
  let eventsWired = false;
  const el = {};

  // ---------------------------------------------------------------- данные

  const project = () => store.project;

  const targetCharacter = () => {
    if (!state.target) return null;
    return (project().characters || []).find((c) => c.id === state.target) || null;
  };

  const voice = () => effectiveVoice(project(), state.target, node());

  const output = () => voice().output || { rate: 48000, channels: 2, bits: 24 };

  const preset = () => {
    const v = voice();
    return v && v.preset != null ? v.preset : 0;
  };

  const params = () => resolveParams(voice() || { preset: preset(), params: {} });

  const applyVoice = (value, label = uiText("Настройка голоса", "Voice settings")) => {
    const hadVoice = !!voiceTarget(project(), state.target, node())?.voice;
    const applied = store.apply([voiceOperation(state.target, node(), value)], label);
    if (!applied.ok) ui.toast(applied.error, 'bad');
    else if (state.open && hadVoice !== !!value) syncHeader();
    return applied;
  };
  const saveVoice = (next, label, extras = {}) => applyVoice({
    ...voice(), ...extras, preset: preset(), params: diffFromPreset(next, preset()),
  }, label);

  const setParam = (id, value) => {
    const next = { ...params(), [id]: Number(value) };
    saveVoice(next);
  };

  const node = () => (state.nodeId ? (project().nodes || []).find((n) => n.id === state.nodeId) : null);

  // A line's own take applies only when that line is the selected voice target.
  const previewSeed = () => {
    const line = node();
    if (!line || state.target === LINE_TARGET) return takeSeed(line, voice());
    return takeSeed({ id: line.id, text: line.text }, voice());
  };

  const phrase = () => {
    const n = node();
    if (n) return String(n.text || '');
    return state.phrase || '';
  };

  const setPhrase = (text) => {
    cancelOperation();
    const clean = String(text || '');
    const n = node();
    if (n) {
      if (n.text === clean) return;
      const res = store.apply([{ op: 'setNodeTexts', items: [{ id: n.id, text: clean }] }],
        { label: uiText("Текст реплики", "Line text"), group: 'studio-text:' + n.id });
      if (!res.ok) ui.toast(res.error || uiText("Не удалось записать текст", "Could not save text"), 'bad');
    } else {
      state.phrase = clean;
    }
  };

  const report = (text) => {
    state.status = text;
    if (el.status) el.status.textContent = text;
  };

  // ---------------------------------------------------------------- звук

  const ensureAudio = () => {
    if (audio) return audio;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.6;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    analyser.connect(gain);
    gain.connect(ctx.destination);
    audio = { ctx, analyser, gain, spectrum: new Uint8Array(analyser.frequencyBinCount), time: new Float32Array(analyser.fftSize) };
    return audio;
  };

  let operation = new AbortController();
  function cancelOperation() {
    operation.abort();
    operation = new AbortController();
  }

  const stop = () => {
    cancelOperation();
    if (state.playing && state.playing.source) {
      try {
        state.playing.source.onended = null;
        state.playing.source.stop();
      } catch {
        /* уже остановлен */
      }
    }
    state.playing = null;
    state.meter = 0;
    state.clip = 0;
    report(uiText("Остановлено", "Stopped"));
    paint();
  };

  const play = (rendered) => {
    const a = ensureAudio();
    if (!a) {
      ui.toast(uiText("В этом окружении нет Web Audio — прослушивание недоступно", "Web Audio is unavailable here. Audio preview is disabled"), 'bad');
      return;
    }
    stop();
    const { ctx, analyser } = a;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const buffer = ctx.createBuffer(2, Math.max(1, rendered.left.length), rendered.rate);
    buffer.copyToChannel(rendered.left, 0);
    buffer.copyToChannel(rendered.right, 1);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    const started = ctx.currentTime;
    state.playing = { source, started, rendered };
    source.onended = () => {
      if (state.playing && state.playing.source === source) {
        state.playing = null;
        state.meter = 0;
        paint();
      }
    };
    source.start();
    report(`${uiText("Прослушивание", "Preview")} · ${formatSeconds(rendered.seconds)}`);
    loop();
  };

  function renderTake(mode, signal, { seed = previewSeed(), wav } = {}) {
    const text = mode === 'line' ? phrase() : '';
    return synthesize({
      params: params(), sample: sampleAudio(voice().sample),
      text: wav ? text : text.slice(0, 600), seed, mode,
    }, { signal, wav });
  }

  const preview = async (mode, fresh) => {
    stop();
    if (fresh) {
      const seed = (Math.random() * 0xffffff) >>> 0 || 1;
      const label = uiText("Новый дубль", "New take");
      const result = state.target === LINE_TARGET && node()
        ? store.apply([{ op: 'updateNode', id: node().id, patch: { voiceSeed: seed } }], label)
        : applyVoice({ ...voice(), seed }, label);
      if (!result.ok) return report(result.error);
    }
    const signal = operation.signal;
    report(uiText("Подготовка звука…", "Preparing audio…"));
    try {
      const take = await renderTake(mode, signal);
      if (!signal.aborted) play(take);
    } catch (err) {
      if (!signal.aborted) report(err.message);
    }
  };

  const listenSelection = () => {
    if (state.sample) return preview('selection');
    report(uiText("Сначала загрузите WAV на вкладке «Сэмпл»", "First load a WAV file in the Sample tab»"));
  };

  // ---------------------------------------------------------------- экспорт

  const ensureDir = async () => {
    if (state.dir) return state.dir;
    const res = await window.sf.voice.chooseDir(ui.settings?.voiceDir || '');
    if (!res || !res.ok || !res.dir) return '';
    state.dir = res.dir;
    await ui.saveSettings({ voiceDir: res.dir });
    return res.dir;
  };

  const exportKind = async (kind) => {
    if (state.exporting) return;
    stop();
    const signal = operation.signal;
    state.exporting = true;
    const { rate, channels, bits } = output();
    const wav = { targetRate: rate, channels, bits };
    try {
      if (kind === 1 || kind === 0) {
        const n = node();
        const speaker = targetCharacter() || (n && project().characters?.find(c => c.id === n.speakerId));
        const base = kind === 1 ? (speaker ? slug(speaker.name) : 'voice') + '_' + slug(n?.id || 'line') : uiText("импульс", "pulse");
        report(uiText("Подготовка WAV…", "Preparing WAV…"));
        const take = await renderTake(kind === 1 ? 'line' : 'pulse', signal, { wav });
        signal.throwIfAborted();
        const saved = await window.sf.voice.saveWave(base + '.wav', take.bytes);
        if (!signal.aborted) report(saved?.ok ? uiText("WAV записан: ", "WAV written: ") + saved.path : saved?.error || uiText("Запись отменена", "Recording cancelled"));
        return;
      }
      const dir = await ensureDir();
      signal.throwIfAborted();
      if (!dir) return;
      const folder = await window.sf.voice.makeDir(dir, uiText("Вариации голоса", "Voice variations"));
      if (!folder?.ok) throw new Error(folder?.error || uiText("Не удалось создать папку вариаций", "Could not create the variations folder"));
      for (let i = 0; i < 8; i++) {
        signal.throwIfAborted();
        report(uiText("Вариация ", "Variation ") + (i + 1) + uiText(" из 8", " of 8"));
        const take = await renderTake('variation', signal, { seed: (previewSeed() + i * 7919) >>> 0, wav });
        signal.throwIfAborted();
        const saved = await window.sf.voice.writeWav(folder.dir, 'voice-' + String(i + 1).padStart(2, '0') + '.wav', take.bytes);
        if (!saved?.ok) throw new Error(saved?.error || uiText("Не удалось записать WAV", "Could not write WAV"));
      }
      if (!signal.aborted) report(uiText("Готово: 8 вариаций в ", "Saved 8 variations in ") + folder.dir);
    } catch (err) {
      if (!signal.aborted) report(err.message);
    } finally {
      state.exporting = false;
    }
  };

  // ---------------------------------------------------------------- голосовые пресеты .dvoice

  const applyPortableVoice = (incoming, label) => {
    if (incoming.sample) sampleAudio(incoming.sample);
    const value = { ...incoming, params: diffFromPreset(resolveParams(incoming), incoming.preset) };
    const ops = [voiceOperation(state.target, node(), value)];
    if (state.target === LINE_TARGET && node()) {
      ops.push({ op: 'updateNode', id: node().id, patch: { voiceSeed: null } });
    }
    const result = store.apply(ops, label);
    if (result.ok) { syncHeader(); renderPage(); }
    return result;
  };

  const library = () => {
    const generation = store.generation, target = state.target, line = state.nodeId;
    return openVoiceLibrary({
      ui,
      suggestedName: (target === LINE_TARGET ? node()?.title : targetCharacter()?.name) || project().meta?.title,
      readVoice: () => ({ ...voice(), seed: previewSeed() }),
      applyVoice: value => {
        if (!state.open || generation !== store.generation || target !== state.target || line !== state.nodeId) return false;
        return applyPortableVoice(value, uiText('Голос из библиотеки', 'Voice from library')).ok;
      },
    });
  };

  const savePreset = async () => {
    const payload = {
      format: 'storyforge-voice',
      version: 2,
      ...voice(),
      seed: previewSeed(),
      phrase: phrase(),
    };
    const res = await window.sf.voice.savePreset(`${slug(targetCharacter() ? targetCharacter().name : 'voice')}.dvoice`, JSON.stringify(payload, null, 2));
    report(res && res.ok ? `${uiText("Голос сохранён", "Voice saved")}: ${res.path}` : (res && res.error) || uiText("Ошибка записи", "Write error"));
  };

  const openPreset = async () => {
    const signal = operation.signal;
    const res = await window.sf.voice.openPreset();
    if (signal.aborted) return;
    if (!res || !res.ok) {
      if (res && res.error) report(res.error);
      return;
    }
    try {
      const data = JSON.parse(res.text);
      if (!data || typeof data.params !== 'object' || !data.params || Array.isArray(data.params)) {
        throw new Error(uiText('Некорректный файл голоса', 'Invalid voice file'));
      }
      const applied = applyPortableVoice(data, uiText("Голос из файла", "Voice from file"));
      if (!applied.ok) {
        report(applied.error || uiText("Не удалось применить голос", "Could not apply voice"));
        return;
      }
      if (data.phrase && !node()) {
        state.phrase = String(data.phrase);
        if (el.words) el.words.value = state.phrase;
      }

      renderPage();
      report(`${uiText("Голос восстановлен", "Voice restored")}: ${res.name || uiText("файл", "file")}`);
    } catch (err) {
      report(uiText("Не удалось прочитать голос: ", "Could not read voice: ") + String((err && err.message) || err));
    }
  };

  // ---------------------------------------------------------------- сэмпл

  const attachSample = (bytes, name) => {
    const sample = packSample(bytes, name);
    const next = { ...params(), source: params().source || 2 };
    const res = saveVoice(next, uiText("Источник — сэмпл", "Sample source"), { sample });
    if (!res.ok) return false;
    state.zoom = 1;
    state.offset = 0;
    return true;
  };

  const openSample = async () => {
    const signal = operation.signal;
    const res = await window.sf.voice.pickSample();
    if (signal.aborted) return;
    if (!res || !res.ok) {
      if (res && res.error) report(res.error);
      return;
    }
    try {
      if (!attachSample(res.bytes, res.name)) return;
      renderPage();
      report(`${uiText("Загружен", "Loaded")} ${state.sampleName}`);
    } catch (err) {
      report(String((err && err.message) || err));
    }
  };

  const resetTrim = () => {
    saveVoice({ ...params(), start: 0, end: 100 }, uiText("Сброс обрезки", "Reset trim"));
    state.zoom = 1;
    state.offset = 0;
    renderPage();
  };

  // ---------------------------------------------------------------- отрисовка

  const paint = () => {
    if (!state.open) return;
    paintPortrait();
    if (state.page === 1) paintWave();
    if (state.page === 2) paintEq();
  };

  const loop = () => {
    cancelAnimationFrame(raf);
    const step = () => {
      if (!state.open || !state.playing) {
        raf = 0;
        return;
      }
      readAnalyser();
      paintPortrait();
      if (state.page === 2) paintEq();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const readAnalyser = () => {
    if (!audio || !state.playing) return;
    const { analyser, spectrum, time } = audio;
    analyser.getByteFrequencyData(spectrum);
    analyser.getFloatTimeDomainData(time);
    let peak = 0;
    for (let i = 0; i < time.length; ++i) peak = Math.max(peak, Math.abs(time[i]));
    state.meter = Math.max(peak, state.meter * 0.88);
    if (peak >= 0.999) state.clip = 28;
    else if (state.clip > 0) state.clip -= 1;
    // спектр в те же 512 «бинов», что в плагине: индекс = f * 1024 / rate
    const rate = audio.ctx.sampleRate;
    for (let k = 0; k < 512; ++k) {
      const bin = Math.min(spectrum.length - 1, Math.round((k * rate) / 1024));
      const value = (spectrum[bin] / 255) * 90 - 90;
      state.bins[k] = Math.max(state.bins[k] - 1.6, value);
    }
  };

  const revealCount = () => {
    if (!state.playing) return null;
    const { ctx, started } = { ctx: audio.ctx, started: state.playing.started };
    const frame = Math.max(0, (ctx.currentTime - started) * state.playing.rendered.rate);
    const list = state.playing.rendered.reveal || [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] <= frame) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  let paintedTheme, colors;
  function canvasColors() {
    const theme = document.documentElement.dataset.theme;
    if (colors && paintedTheme === theme) return colors;
    const css = getComputedStyle(document.documentElement);
    const value = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const light = theme === 'light';
    colors = {
      bg: value('--obs-bg', light ? '#fff' : '#1e1e1e'),
      ink: value('--obs-text', light ? '#27252a' : '#e2e0e3'),
      soft: value('--obs-muted', light ? '#646166' : '#aca9ad'),
      line: value('--obs-border', light ? '#d9d6db' : '#3b393e'),
      accent: value('--obs-accent', light ? '#714cc7' : '#ae91ee'),
      shade: light ? 'rgba(111,77,196,.14)' : 'rgba(157,126,219,.18)',
      warning: light ? '#aa363b' : '#f28989',
    };
    paintedTheme = theme;
    return colors;
  }

  const paintPortrait = () => {
    const canvas = el.portrait;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 90;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    const palette = canvasColors();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = palette.line;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

    const px = Math.max(2, Math.min(5, Math.floor((h - 16) / 13)));
    const artW = 16 * px;
    const x0 = 14;
    const y0 = Math.round((h - 12 * px) / 2);
    ctx.fillStyle = palette.ink;
    for (let row = 0; row < 12; ++row) {
      for (let col = 0; col < 16; ++col) {
        if (PORTRAIT_ART[row][col] === '#') ctx.fillRect(x0 + col * px, y0 + row * px, px, px);
      }
    }

    const full = phrase() || '…';
    const shown = revealCount();
    const line = shown == null ? full : full.slice(0, shown);
    const textLeft = x0 + artW + 16;
    const textWidth = Math.max(40, w - textLeft - 16);
    ctx.fillStyle = palette.ink;
    ctx.font = `600 ${Math.max(12, Math.min(19, h * 0.21))}px "Cascadia Mono", Consolas, monospace`;
    ctx.textBaseline = 'middle';
    const words = line.split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
      const probe = current ? current + ' ' + word : word;
      if (ctx.measureText(probe).width > textWidth && current) {
        lines.push(current);
        current = word;
      } else current = probe;
      if (lines.length === 3) break;
    }
    if (current && lines.length < 3) lines.push(current);
    const lh = Math.max(14, h * 0.24);
    const top = h / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((text, i) => {
      let out = text;
      while (ctx.measureText(out).width > textWidth && out.length > 1) out = out.slice(0, -1);
      ctx.fillText(out, textLeft, top + i * lh);
    });

    const meterW = Math.max(0, Math.min(1, state.meter)) * (w - 8);
    ctx.fillStyle = state.clip > 0 ? palette.warning : palette.accent;
    ctx.fillRect(4, h - 6, meterW, 2);
  };

  const waveGeometry = () => {
    const canvas = el.wave;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 84;
    return { w, h };
  };

  const pctAt = (x) => {
    const { w } = waveGeometry();
    return Math.max(0, Math.min(100, state.offset + (100 * x) / (state.zoom * Math.max(1, w))));
  };

  const xFor = (value) => {
    const { w } = waveGeometry();
    return ((value - state.offset) * state.zoom * w) / 100;
  };

  const paintWave = () => {
    const canvas = el.wave;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = waveGeometry();
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    const palette = canvasColors();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, w, h);

    const clip = state.sample;
    if (!clip) {
      ctx.fillStyle = palette.soft;
      ctx.font = '12px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(uiText("Перетащите WAV сюда или нажмите «Открыть WAV»", "Drop a WAV file here or click Open WAV»"), w / 2, h / 2);
      ctx.textAlign = 'left';
      return;
    }

    const p = params();
    const startX = xFor(p.start);
    const endX = xFor(p.end);
    ctx.fillStyle = palette.shade;
    ctx.fillRect(startX, 0, Math.max(1, endX - startX), h);

    const data = clip.pcm;
    const n = data.length;
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < w; ++x) {
      const a = Math.max(0, Math.min(n - 1, Math.floor((pctAt(x) / 100) * n)));
      const b = Math.max(a + 1, Math.min(n, Math.floor((pctAt(x + 1) / 100) * n)));
      let min = 0;
      let max = 0;
      const stride = Math.max(1, Math.floor((b - a) / 64));
      for (let i = a; i < b; i += stride) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      ctx.moveTo(x + 0.5, h * (0.5 - 0.44 * max));
      ctx.lineTo(x + 0.5, h * (0.5 - 0.44 * min) + 1);
    }
    ctx.stroke();

    ctx.strokeStyle = palette.soft;
    for (const value of [p.start, p.end]) {
      const x = Math.round(xFor(value)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    ctx.fillStyle = palette.soft;
    ctx.font = '11px "Cascadia Mono", Consolas, monospace';
    ctx.fillText(`${state.sampleName || clip.name || uiText("сэмпл", "sample")} · ${formatSeconds(n / clip.rate)} · ${uiText("зум", "zoom")} ${state.zoom.toFixed(1)}×`, 6, 13);
  };

  const eqGeom = () => {
    const canvas = el.eq;
    return { w: canvas.clientWidth || 600, h: canvas.clientHeight || 126 };
  };

  const eqX = (freq, w) => (Math.log(freq / 20) / Math.log(1000)) * w;
  const eqFreq = (x, w) => 20 * Math.pow(1000, Math.max(0, Math.min(1, x / w)));
  const eqY = (dbValue, h) => h * (0.5 - dbValue / 40);
  const eqDb = (y, h) => 40 * (0.5 - y / h);

  const paintEq = () => {
    const canvas = el.eq;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = eqGeom();
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    const palette = canvasColors();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, w, h);

    const p = params();
    const rate = 48000;

    ctx.strokeStyle = palette.line;
    ctx.lineWidth = 1;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = Math.round(eqX(f, w)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (const d of [-12, 0, 12]) {
      const y = Math.round(eqY(d, h)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // живой спектр
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x < w; x += 2) {
      const f = eqFreq(x, w);
      const bin = Math.max(0, Math.min(511, Math.round((f * 1024) / rate)));
      const value = Math.max(-90, Math.min(0, state.bins[bin] || -90));
      const y = h * (1 - Math.max(0, Math.min(1, (value + 72) / 72)));
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = palette.shade;
    ctx.fill();

    // кривая АЧХ
    ctx.beginPath();
    for (let x = 0; x < w; x += 2) {
      const value = eqResponseDb(p, eqFreq(x, w), rate);
      const y = eqY(value, h);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 2;
    ctx.stroke();

    // точки полос
    for (let k = 0; k < 7; ++k) {
      const on = !!p['b' + k + 'on'];
      const freq = p['b' + k + 'freq'] || 1000;
      const gain = k === 0 || k === 6 ? 0 : p['b' + k + 'gain'] || 0;
      const x = eqX(freq, w);
      const y = eqY(gain, h);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = on ? palette.accent : palette.soft;
      ctx.fill();
      ctx.fillStyle = palette.soft;
      ctx.font = '10px "Cascadia Mono", Consolas, monospace';
      ctx.fillText(String(k + 1), x + 7, y - 6);
    }
  };

  // ---------------------------------------------------------------- элементы управления

  const controlHtml = (spec) => {
    const p = params();
    const value = p[spec.id];
    const label = `<span class="studio-label">${ui.escapeHTML(spec.label)}</span>`;
    if (spec.names) {
      const options = spec.names
        .map((name, index) => `<option value="${index}"${Math.round(value) === index ? ' selected' : ''}>${ui.escapeHTML(name)}</option>`)
        .join('');
      return `<label class="studio-control">${label}<select class="select select-sm" data-pid="${spec.id}">${options}</select></label>`;
    }
    if (spec.toggle) {
      return `<label class="studio-control studio-toggle"><input type="checkbox" data-pid="${spec.id}"${Number(value) ? ' checked' : ''}><span>${ui.escapeHTML(spec.label)}</span></label>`;
    }
    return `<label class="studio-control">${label}
      <span class="studio-slider">
        <input type="range" data-pid="${spec.id}" min="${spec.lo}" max="${spec.hi}" step="${spec.step}" value="${value}">
        <output class="studio-value" data-out="${spec.id}">${fmt(value, spec)}${spec.unit ? ' ' + ui.escapeHTML(spec.unit) : ''}</output>
      </span></label>`;
  };

  const gridHtml = (tab) => {
    const list = specsForTab(tab);
    return `<div class="studio-grid">${list.map(controlHtml).join('')}</div>`;
  };

  const pageHtml = () => {
    if (state.page === 0) return gridHtml(0);
    if (state.page === 3) return gridHtml(3);
    if (state.page === 1) {
      return `<canvas class="studio-wave" data-el="wave"></canvas>
        <div class="studio-row">
          <button class="btn btn-sm" data-st="openWav">${icon('plus', 14)} ${uiText("Открыть", "Open")} WAV</button>
          <button class="btn btn-sm" data-st="listenSelection">${uiText("Слушать выделение", "Play selection")}</button>
          <button class="btn btn-sm" data-st="resetTrim">${uiText("Сбросить обрезку", "Reset trim")}</button>
        </div>
        ${gridHtml(1)}`;
    }
    if (state.page === 2) {
      return `<canvas class="studio-eq" data-el="eq"></canvas>
        <p class="hint-text">${uiText("Точки 1–7 перетаскиваются: по горизонтали частота, по вертикали усиление. Срез низких и высоких — только частота", "Drag points 1–7 horizontally to change frequency and vertically to change gain. The low-cut and high-cut bands only adjust frequency")}.</p>
        ${gridHtml(2)}`;
    }
    const rateOptions = RATES.map((r) => `<option value="${r.id}"${output().rate === r.id ? ' selected' : ''}>${r.label}</option>`).join('');
    const chOptions = CHANNELS.map((c) => `<option value="${c.id}"${output().channels === c.id ? ' selected' : ''}>${c.label}</option>`).join('');
    const bitOptions = DEPTHS.map((d) => `<option value="${d.id}"${output().bits === d.id ? ' selected' : ''}>${d.label}</option>`).join('');
    return `<label class="studio-words-wrap">
        <span class="studio-label">${uiText("Реплика для озвучки", "Line to voice")} ${node() ? uiText("· пишется в узел", "· saved to the node") : uiText("· предпросмотр", "· preview")} · ${uiText("прослушивание до 600 знаков", "preview up to 600 characters")}</span>
        <textarea class="textarea studio-words" data-el="words" rows="3">${ui.escapeHTML(phrase())}</textarea>
      </label>
      <div class="studio-row">
        <select class="select select-sm" data-st="rate">${rateOptions}</select>
        <select class="select select-sm" data-st="channels">${chOptions}</select>
        <select class="select select-sm" data-st="bits">${bitOptions}</select>
        <button class="btn btn-sm" data-st="exportPulse">WAV · ${uiText("импульс", "pulse")}</button>
        <button class="btn btn-sm btn-primary" data-st="exportLine">WAV · ${uiText("реплика", "line")}</button>
        <button class="btn btn-sm" data-st="exportVariations">8 ${uiText("вариаций", "variations")}</button>
      </div>
      ${gridHtml(4)}`;
  };

  const renderPage = () => {
    if (!el.page) return;
    state.sampleName = voice().sample?.name || '';
    try { state.sample = sampleAudio(voice().sample); }
    catch (err) { state.sample = null; report(err.message); }
    if (el.main) {
      el.main.innerHTML = MAIN_SPECS.map(controlHtml).join('');
      wireControls(el.main);
    }
    el.page.innerHTML = pageHtml();
    el.page.dataset.page = String(state.page);
    el.wave = el.page.querySelector('[data-el="wave"]');
    el.eq = el.page.querySelector('[data-el="eq"]');
    el.words = el.page.querySelector('[data-el="words"]');
    wirePage();
    paint();
  };

  const wireControls = (container) => {
    container.querySelectorAll('[data-pid]').forEach((input) => {
      const id = input.dataset.pid;
      const spec = specById(id);
      if (!spec) return;
      const commit = () => {
        const value = input.type === 'checkbox' ? (input.checked ? 1 : 0) : Number(input.value);
        setParam(id, value);
        const out = container.querySelector(`[data-out="${id}"]`);
        if (out) out.textContent = `${fmt(value, spec)}${spec.unit ? ' ' + spec.unit : ''}`;
        if (state.page === 2) paintEq();
      };
      input.addEventListener('input', commit);
      input.addEventListener('change', commit);
    });
  };

  const wirePage = () => {
    wireControls(el.page);

    const words = el.words;
    if (words) {
      words.addEventListener('input', () => setPhrase(words.value));
    }

    el.page.querySelectorAll('[data-st]').forEach((button) => {
      button.addEventListener('click', () => {
        const act = button.dataset.st;
        if (act === 'openWav') openSample();
        else if (act === 'listenSelection') listenSelection();
        else if (act === 'resetTrim') resetTrim();
        else if (act === 'exportPulse') exportKind(0);
        else if (act === 'exportLine') exportKind(1);
        else if (act === 'exportVariations') exportKind(2);
      });
    });

    for (const key of ['rate', 'channels', 'bits']) {
      const select = el.page.querySelector(`[data-st="${key}"]`);
      select?.addEventListener('change', () => {
        applyVoice({ ...voice(), output: { ...output(), [key]: Number(select.value) } },
          uiText("Формат WAV", "WAV format"));
      });
    }

    wireWave();
    wireEq();
  };

  const wireWave = () => {
    const canvas = el.wave;
    if (!canvas) return;
    let drag = 0;
    let anchor = 0;

    const onDown = (event) => {
      if (!state.sample) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      anchor = pctAt(x);
      const p = params();
      const a = Math.abs(xFor(p.start) - x);
      const b = Math.abs(xFor(p.end) - x);
      const near = Math.min(a, b);
      drag = near > 10 ? 0 : a < b ? 1 : 2;
      canvas.setPointerCapture?.(event.pointerId);
    };

    const onMove = (event) => {
      if (!drag || !state.sample) return;
      const rect = canvas.getBoundingClientRect();
      const value = pctAt(event.clientX - rect.left);
      const p = params();
      const next = { ...p };
      if (drag !== 2) next.start = drag === 0 ? Math.min(anchor, value, 99.99) : Math.min(value, p.end - 0.01);
      if (drag !== 1) next.end = drag === 0 ? Math.max(anchor, value, 0.01) : Math.max(value, p.start + 0.01);
      saveVoice(next, uiText("Обрезка сэмпла", "Sample trim"));
      paintWave();
    };

    const onUp = () => {
      if (drag) renderPage();
      drag = 0;
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!state.sample) return;
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const focus = pctAt(event.clientX - rect.left);
        state.zoom = Math.max(1, Math.min(64, state.zoom * (event.deltaY > 0 ? 1 / 1.5 : 1.5)));
        state.offset = Math.max(0, Math.min(100 - 100 / state.zoom, focus - (100 * (event.clientX - rect.left)) / (state.zoom * rect.width)));
        paintWave();
      },
      { passive: false },
    );
  };

  const wireEq = () => {
    const canvas = el.eq;
    if (!canvas) return;
    let grabbed = -1;

    const onDown = (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      grabbed = -1;
      let best = 16;
      const p = params();
      for (let k = 0; k < 7; ++k) {
        const px = eqX(p['b' + k + 'freq'] || 1000, rect.width);
        const py = eqY(k === 0 || k === 6 ? 0 : p['b' + k + 'gain'] || 0, rect.height);
        const dist = Math.hypot(px - x, py - y);
        if (dist < best) {
          best = dist;
          grabbed = k;
        }
      }
      if (grabbed >= 0) canvas.setPointerCapture?.(event.pointerId);
    };

    const onMove = (event) => {
      if (grabbed < 0) return;
      const rect = canvas.getBoundingClientRect();
      const next = { ...params() };
      next['b' + grabbed + 'on'] = 1;
      next['b' + grabbed + 'freq'] = Math.max(20, Math.min(20000, eqFreq(event.clientX - rect.left, rect.width)));
      if (grabbed > 0 && grabbed < 6) {
        next['b' + grabbed + 'gain'] = Math.max(-18, Math.min(18, eqDb(event.clientY - rect.top, rect.height)));
      }
      saveVoice(next, uiText("Эквалайзер", "Equalizer"));
      paintEq();
    };

    const onUp = () => {
      if (grabbed >= 0) {
        grabbed = -1;
        renderPage();
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
  };

  // ---------------------------------------------------------------- каркас

  const build = () => {
    if (shellLanguage === getLanguage()) return;
    shellLanguage = getLanguage();
    root.innerHTML = `
      <div class="studio-backdrop" data-st="backdrop"></div>
      <section class="studio-card" role="dialog" aria-label="${uiText("Студия голоса", "Voice Studio")}">
        <header class="studio-head">
          <h2 class="studio-title">${icon('volume', 18)} ${uiText("Студия голоса", "Voice Studio")}</h2>
          <button class="btn btn-sm" data-st="library">${icon('folder', 14)} ${uiText("Библиотека голосов", "Voice library")}</button>
          <button class="btn btn-sm" data-st="openVoice">${icon('search', 14)} ${uiText("Открыть голос", "Open voice")}</button>
          <button class="btn btn-sm" data-st="saveVoice">${icon('copy', 14)} ${uiText("Сохранить голос", "Save voice")}</button>
          <span class="studio-status" data-el="status"></span>
          <button class="btn btn-sm btn-ghost" data-st="compact" title="${uiText("Компактный размер", "Compact layout")}">${uiText("Компактно", "Compact")}</button>
          <button class="btn btn-icon" data-st="close" title="${uiText("Закрыть", "Close")} (Esc)" aria-label="${uiText("Закрыть студию голоса", "Close Voice Studio")}">${icon('close', 16)}</button>
        </header>
        <div class="studio-target">
          <label class="studio-label" for="studioVoiceTarget">${uiText("Голос", "Voice")}</label>
          <select class="select select-sm" id="studioVoiceTarget" data-st="target"></select>
          <label class="studio-label" for="studioVoicePreset">${uiText("Характер", "Personality")}</label>
          <select class="select select-sm" id="studioVoicePreset" data-st="preset"></select>
          <button class="btn btn-sm" data-st="inherit">${uiText("Наследовать", "Inherit")}</button>
        </div>
        <canvas class="studio-portrait" data-el="portrait"></canvas>
        <div class="studio-main" data-el="main"></div>
        <div class="studio-row studio-actions">
          <button class="btn btn-sm" data-st="pulse">${uiText("Один звук", "Single sound")}</button>
          <button class="btn btn-sm btn-primary" data-st="line">${uiText("Озвучить реплику", "Voice this line")}</button>
          <button class="btn btn-sm" data-st="stop">${uiText("Стоп", "Stop")}</button>
          <button class="btn btn-sm" data-st="replay">${uiText("Повторить дубль", "Replay take")}</button>
          <button class="btn btn-sm" data-st="newDub">${uiText("Новый дубль", "New take")}</button>
        </div>
        <nav class="studio-tabs">${TABS.map((name, index) => `<button class="tab" data-page="${index}">${ui.escapeHTML(name)}</button>`).join('')}</nav>
        <div class="studio-page" data-el="page"></div>
      </section>`;

    el.card = root.querySelector('.studio-card');
    el.status = root.querySelector('[data-el="status"]');
    el.portrait = root.querySelector('[data-el="portrait"]');
    el.page = root.querySelector('[data-el="page"]');
    el.main = root.querySelector('[data-el="main"]');
    el.target = root.querySelector('[data-st="target"]');
    el.preset = root.querySelector('[data-st="preset"]');

    root.querySelectorAll('[data-st]').forEach((button) => {
      const act = button.dataset.st;
      button.addEventListener('click', () => {
        if (act === 'backdrop' || act === 'close') close();
        else if (act === 'openVoice') openPreset();
        else if (act === 'library') library();
        else if (act === 'inherit') {
          if (applyVoice(null, uiText('Наследовать голос', 'Inherit voice')).ok) { syncHeader(); renderPage(); }
        }
        else if (act === 'saveVoice') savePreset();
        else if (act === 'compact') {
          state.compact = !state.compact;
          el.card.classList.toggle('is-compact', state.compact);
          paint();
        } else if (act === 'pulse') preview('pulse');
        else if (act === 'line') preview('line');
        else if (act === 'stop') stop();
        else if (act === 'replay') preview('line'); else if (act === 'newDub') preview('line', true);
      });
    });

    root.querySelectorAll('.studio-tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        state.page = Number(tab.dataset.page);
        syncTabs();
        renderPage();
      });
    });

    el.target.addEventListener('change', () => {
      stop();
      state.target = el.target.value;
      syncHeader();
      renderPage();
    });

    el.preset.addEventListener('change', () => {
      const id = Number(el.preset.value);
      applyVoice({ ...voice(), preset: id, params: {} }, uiText("Характер голоса", "Voice character"));
      renderPage();
    });

    if (eventsWired) return;
    eventsWired = true;
    window.addEventListener('keydown', (event) => {
      if (!state.open) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    });

    root.addEventListener('dragover', (event) => {
      if (event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
    });
    root.addEventListener('drop', async (event) => {
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file) return;
      event.preventDefault();
      if (!/\.wav$/i.test(file.name)) {
        report(uiText("Нужен WAV-файл", "Select a WAV file"));
        return;
      }
      try {
        const signal = operation.signal;
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (signal.aborted) return;
        if (!attachSample(bytes, file.name)) return;
        state.page = 1;
        syncTabs();
        renderPage();
        report(`${uiText("Загружен", "Loaded")} ${file.name}`);
      } catch (err) {
        report(String((err && err.message) || err));
      }
    });
  };


  const syncTabs = () => {
    root.querySelectorAll('.studio-tabs .tab').forEach((tab) => {
      const active = Number(tab.dataset.page) === state.page;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  };

  const syncHeader = () => {
    const characters = project().characters || [];
    if (state.target && !voiceTarget(project(), state.target, node())) state.target = '';
    const line = node();
    const options = [`<option value="">${uiText("Голос проекта", "Project voice")}</option>`]
      .concat(line?.type === 'line' ? [`<option value="${LINE_TARGET}"${state.target === LINE_TARGET ? ' selected' : ''}>${uiText('Выбранная реплика', 'Selected line')} · ${ui.escapeHTML(line.title || line.id)}</option>`] : [])
      .concat(
        characters.map(
          (ch) =>
            `<option value="${ui.escapeHTML(ch.id)}"${state.target === ch.id ? ' selected' : ''}>${ui.escapeHTML(ch.name)}${ch.voice ? '' : uiText(" · наследует", " · inherits")}</option>`,
        ),
      )
      .join('');
    el.target.innerHTML = options;
    root.querySelector('[data-st="inherit"]').disabled = !state.target || !voiceTarget(project(), state.target, line)?.voice;
    el.preset.innerHTML = FACTORY_VOICES.map(
      (v) => `<option value="${v.id}"${preset() === v.id ? ' selected' : ''}>${ui.escapeHTML(v.name)}</option>`,
    ).join('');
    if (el.status && !state.status) el.status.textContent = '';
  };

  function open(targetId) {
    ui.flushEdits?.();
    build();
    cancelOperation();
    state.open = true;
    const selection = store.selection;
    state.nodeId = selection && selection.kind === 'node' ? selection.id : '';
    state.target = targetId ?? (node()?.type === 'line' ? LINE_TARGET : '');
    root.classList.remove('hidden');
    syncHeader();
    syncTabs();
    renderPage();
    report(state.status || uiText("Готово", "Done"));
    el.card.focus?.();
  }

  function close() {
    if (!state.open) return;
    stop();
    state.open = false;
    root.classList.add('hidden');
    if (ui.voice && typeof ui.voice.render === 'function') ui.voice.render();
  }

  let generation = store.generation;
  store.subscribe(event => {
    if (generation !== store.generation) {
      generation = store.generation;
      close();
      state.sample = null;
      state.sampleName = '';
      clearSampleCache();
      state.phrase = '';
      return;
    }
    if (!state.open) return;
    if (event.type === 'change' || event.type === 'project') {
      cancelOperation();
      if (el.words && el.words.value !== phrase()) el.words.value = phrase();
      if (event.type === 'project') { syncHeader(); renderPage(); }
    }
  });

  return {
    open,
    close,
    render: () => {
      if (!state.open) return;
      build();
      syncHeader();
      syncTabs();
      renderPage();
    },
    isOpen: () => state.open,
    setTarget: (id) => {
      stop();
      state.target = id || '';
      if (state.open) {
        syncHeader();
        renderPage();
      }
    },
    setNode: (id) => {
      stop();
      state.nodeId = id || '';
      state.target = node()?.type === 'line' ? LINE_TARGET : '';
      if (state.open) syncHeader();
      if (state.open) renderPage();
    },
    get state() {
      return state;
    },
  };
}
