import { t as uiText, onLanguageChange } from '../i18n.js';
// Параметры голоса: тот же набор, что был у плагина Dialogue Voice Studio,
// с русскими подписями и группами для интерфейса.
//
// В проект (.sfproj) сохраняются только отличия от значений по умолчанию —
// иначе каждый персонаж тянул бы за собой сотню чисел.

export const GROUPS = {
  get voice() { return uiText("Голос", "Voice"); },
  get sample() { return uiText("Сэмпл", "Sample"); },
  get eq() { return uiText("Эквалайзер", "Equalizer"); },
  get fx() { return uiText("Эффекты", "Effects"); },
  get diction() { return uiText("Дикция", "Diction"); },
};

/** Спецификация параметров: id, подпись, единица, диапазон, шаг, значение по умолчанию. */
export const SPECS = [
  // — голос и импульс
  { id: 'pitch', get label() { return uiText("Высота", "Pitch"); }, unit: 'st', lo: -36, hi: 36, step: 0.1, def: 0, group: 'voice' },
  { id: 'duration', get label() { return uiText("Длительность слога", "Syllable length"); }, get unit() { return uiText("мс", "ms"); }, lo: 10, hi: 1500, step: 1, def: 82, group: 'voice' },
  { id: 'speed', get label() { return uiText("Скорость речи", "Speech rate"); }, get unit() { return uiText("букв/с", "chars/s"); }, lo: 3, hi: 60, step: 0.1, def: 16, group: 'voice' },
  {
    id: 'source',
    get label() { return uiText("Источник", "Source"); },
    unit: '',
    lo: 0,
    hi: 2,
    step: 1,
    def: 0,
    group: 'voice',
    get names() { return [uiText("Синтез", "Synthesis"), uiText("Сэмпл", "Sample"), uiText("Смесь", "Mix")]; },
  },
  { id: 'blend', get label() { return uiText("Доля сэмпла", "Sample mix"); }, unit: '%', lo: 0, hi: 100, step: 1, def: 50, group: 'voice' },

  // — осцилляторы
  ...oscSpecs(1, { wave: 3, level: 64, oct: 0 }),
  ...oscSpecs(2, { wave: 1, level: 22, oct: -1 }),

  // — огибающая
  { id: 'attack', get label() { return uiText("Атака", "Attack"); }, get unit() { return uiText("мс", "ms"); }, lo: 0.1, hi: 300, step: 0.1, def: 3, group: 'voice' },
  { id: 'decay', get label() { return uiText("Спад", "Decay"); }, get unit() { return uiText("мс", "ms"); }, lo: 1, hi: 500, step: 1, def: 34, group: 'voice' },
  { id: 'sustain', get label() { return uiText("Сустейн", "Sustain"); }, unit: '%', lo: 0, hi: 100, step: 1, def: 64, group: 'voice' },
  { id: 'release', get label() { return uiText("Затухание", "Release"); }, get unit() { return uiText("мс", "ms"); }, lo: 1, hi: 600, step: 1, def: 11, group: 'voice' },
  { id: 'glide', get label() { return uiText("Глайд", "Glide"); }, get unit() { return uiText("мс", "ms"); }, lo: 0, hi: 400, step: 1, def: 0, group: 'voice' },
  { id: 'vib', get label() { return uiText("Вибрато", "Vibrato"); }, unit: 'ct', lo: 0, hi: 150, step: 1, def: 0, group: 'voice' },
  { id: 'vibRate', get label() { return uiText("Частота вибрато", "Vibrato rate"); }, get unit() { return uiText("Гц", "Hz"); }, lo: 0.2, hi: 18, step: 0.1, def: 6, group: 'voice' },

  // — сэмпл
  { id: 'start', get label() { return uiText("Начало", "Start"); }, unit: '%', lo: 0, hi: 99.99, step: 0.01, def: 0, group: 'sample' },
  { id: 'end', get label() { return uiText("Конец", "Ending"); }, unit: '%', lo: 0.01, hi: 100, step: 0.01, def: 100, group: 'sample' },
  { id: 'samplePitch', get label() { return uiText("Высота сэмпла", "Sample pitch"); }, unit: 'st', lo: -36, hi: 36, step: 0.1, def: 0, group: 'sample' },
  { id: 'sampleFine', get label() { return uiText("Точная настройка", "Fine tune"); }, unit: 'ct', lo: -100, hi: 100, step: 1, def: 0, group: 'sample' },
  { id: 'fadeIn', get label() { return uiText("Плавный вход", "Fade in"); }, get unit() { return uiText("мс", "ms"); }, lo: 0, hi: 250, step: 0.1, def: 2, group: 'sample' },
  { id: 'fadeOut', get label() { return uiText("Плавный выход", "Fade out"); }, get unit() { return uiText("мс", "ms"); }, lo: 0, hi: 500, step: 0.1, def: 4, group: 'sample' },
  { id: 'reverse', get label() { return uiText("Реверс", "Reverse"); }, unit: '', lo: 0, hi: 1, step: 1, def: 0, group: 'sample', toggle: true },
  { id: 'normalize', get label() { return uiText("Нормализация", "Normalize"); }, unit: '', lo: 0, hi: 1, step: 1, def: 0, group: 'sample', toggle: true },

  // — эквалайзер
  { id: 'eq', get label() { return uiText("Эквалайзер", "Equalizer"); }, unit: '', lo: 0, hi: 1, step: 1, def: 1, group: 'eq', toggle: true },
  ...eqSpecs(),

  // — эффекты
  { id: 'filter', get label() { return uiText("Фильтр", "Filter"); }, unit: '', lo: 0, hi: 1, step: 1, def: 0, group: 'fx', toggle: true },
  {
    id: 'filterType',
    get label() { return uiText("Тип фильтра", "Filter type"); },
    unit: '',
    lo: 0,
    hi: 2,
    step: 1,
    def: 0,
    group: 'fx',
    get names() { return [uiText("Низкие", "Low-pass"), uiText("Высокие", "High-pass"), uiText("Полоса", "Band-pass")]; },
  },
  { id: 'cutoff', get label() { return uiText("Срез", "Cutoff"); }, get unit() { return uiText("Гц", "Hz"); }, lo: 30, hi: 20000, step: 1, def: 4200, group: 'fx' },
  { id: 'res', get label() { return uiText("Резонанс", "Resonance"); }, unit: 'Q', lo: 0.2, hi: 12, step: 0.01, def: 0.72, group: 'fx' },
  { id: 'crush', get label() { return uiText("Биткрашер", "Bitcrusher"); }, unit: '', lo: 0, hi: 1, step: 1, def: 0, group: 'fx', toggle: true },
  { id: 'bits', get label() { return uiText("Битность", "Bit depth"); }, get unit() { return uiText("бит", "bit"); }, lo: 2, hi: 16, step: 1, def: 8, group: 'fx' },
  { id: 'crushRate', get label() { return uiText("Частота удержания", "Sample hold rate"); }, get unit() { return uiText("Гц", "Hz"); }, lo: 1000, hi: 48000, step: 1, def: 12000, group: 'fx' },
  { id: 'sat', get label() { return uiText("Сатурация", "Saturation"); }, unit: '', lo: 0, hi: 1, step: 1, def: 0, group: 'fx', toggle: true },
  { id: 'drive', get label() { return uiText("Драйв", "Drive"); }, get unit() { return uiText("дБ", "dB"); }, lo: 0, hi: 30, step: 0.1, def: 6, group: 'fx' },
  { id: 'comp', get label() { return uiText("Компрессор", "Compressor"); }, unit: '', lo: 0, hi: 1, step: 1, def: 0, group: 'fx', toggle: true },
  { id: 'threshold', get label() { return uiText("Порог", "Threshold"); }, get unit() { return uiText("дБ", "dB"); }, lo: -60, hi: 0, step: 0.1, def: -16, group: 'fx' },
  { id: 'ratio', get label() { return uiText("Сжатие", "Ratio"); }, unit: ':1', lo: 1, hi: 20, step: 0.1, def: 3, group: 'fx' },
  { id: 'compAtk', get label() { return uiText("Атака компрессора", "Compressor attack"); }, get unit() { return uiText("мс", "ms"); }, lo: 0.2, hi: 100, step: 0.1, def: 6, group: 'fx' },
  { id: 'compRel', get label() { return uiText("Спад компрессора", "Compressor release"); }, get unit() { return uiText("мс", "ms"); }, lo: 5, hi: 600, step: 1, def: 90, group: 'fx' },
  { id: 'delay', get label() { return uiText("Задержка", "Delay"); }, unit: '', lo: 0, hi: 1, step: 1, def: 0, group: 'fx', toggle: true },
  { id: 'delayMs', get label() { return uiText("Время задержки", "Delay time"); }, get unit() { return uiText("мс", "ms"); }, lo: 10, hi: 900, step: 1, def: 160, group: 'fx' },
  { id: 'feedback', get label() { return uiText("Обратная связь", "Feedback"); }, unit: '%', lo: 0, hi: 80, step: 1, def: 28, group: 'fx' },
  { id: 'delayMix', get label() { return uiText("Доля задержки", "Delay mix"); }, unit: '%', lo: 0, hi: 100, step: 1, def: 18, group: 'fx' },
  { id: 'reverb', get label() { return uiText("Реверберация", "Reverb"); }, unit: '', lo: 0, hi: 1, step: 1, def: 0, group: 'fx', toggle: true },
  { id: 'room', get label() { return uiText("Размер комнаты", "Room size"); }, unit: '%', lo: 0, hi: 100, step: 1, def: 42, group: 'fx' },
  { id: 'damp', get label() { return uiText("Поглощение", "Damping"); }, unit: '%', lo: 0, hi: 100, step: 1, def: 48, group: 'fx' },
  { id: 'revMix', get label() { return uiText("Доля реверба", "Reverb mix"); }, unit: '%', lo: 0, hi: 100, step: 1, def: 16, group: 'fx' },
  { id: 'ring', get label() { return uiText("Кольцевая модуляция", "Ring modulation"); }, unit: '', lo: 0, hi: 1, step: 1, def: 0, group: 'fx', toggle: true },
  { id: 'carrier', get label() { return uiText("Несущая", "Carrier"); }, get unit() { return uiText("Гц", "Hz"); }, lo: 10, hi: 2400, step: 1, def: 135, group: 'fx' },
  { id: 'ringMix', get label() { return uiText("Доля модуляции", "Modulation mix"); }, unit: '%', lo: 0, hi: 100, step: 1, def: 65, group: 'fx' },
  { id: 'trem', get label() { return uiText("Тремоло", "Tremolo"); }, unit: '', lo: 0, hi: 1, step: 1, def: 0, group: 'fx', toggle: true },
  { id: 'tremRate', get label() { return uiText("Частота тремоло", "Tremolo rate"); }, get unit() { return uiText("Гц", "Hz"); }, lo: 0.5, hi: 40, step: 0.1, def: 12, group: 'fx' },
  { id: 'tremDepth', get label() { return uiText("Глубина тремоло", "Tremolo depth"); }, unit: '%', lo: 0, hi: 100, step: 1, def: 60, group: 'fx' },
  { id: 'fold', get label() { return uiText("Волновой фолдер", "Wavefolder"); }, unit: '', lo: 0, hi: 1, step: 1, def: 0, group: 'fx', toggle: true },
  { id: 'foldAmt', get label() { return uiText("Сила фолдинга", "Fold amount"); }, unit: 'x', lo: 1, hi: 12, step: 0.1, def: 4, group: 'fx' },
  { id: 'foldMix', get label() { return uiText("Доля фолдинга", "Fold mix"); }, unit: '%', lo: 0, hi: 100, step: 1, def: 65, group: 'fx' },
  { id: 'out', get label() { return uiText("Выход", "Exit"); }, get unit() { return uiText("дБ", "dB"); }, lo: -60, hi: 12, step: 0.1, def: -6, group: 'fx' },
  { id: 'pan', get label() { return uiText("Панорама", "Pan"); }, unit: '%', lo: -100, hi: 100, step: 1, def: 0, group: 'fx' },

  // — дикция
  { id: 'every', get label() { return uiText("Шаг импульсов", "Pulse interval"); }, get unit() { return uiText("букв", "letters"); }, lo: 1, hi: 8, step: 1, def: 1, group: 'diction' },
  { id: 'comma', get label() { return uiText("Пауза на запятой", "Comma pause"); }, get unit() { return uiText("мс", "ms"); }, lo: 0, hi: 2000, step: 1, def: 150, group: 'diction' },
  { id: 'period', get label() { return uiText("Пауза в конце фразы", "End-of-phrase pause"); }, get unit() { return uiText("мс", "ms"); }, lo: 0, hi: 3000, step: 1, def: 300, group: 'diction' },
  { id: 'ellipsis', get label() { return uiText("Пауза на многоточии", "Ellipsis pause"); }, get unit() { return uiText("мс", "ms"); }, lo: 0, hi: 4000, step: 1, def: 530, group: 'diction' },
  { id: 'spread', get label() { return uiText("Разброс высоты", "Pitch variation"); }, unit: 'st', lo: 0, hi: 12, step: 0.1, def: 1.4, group: 'diction' },
  { id: 'jitter', get label() { return uiText("Разброс громкости", "Volume variation"); }, unit: '%', lo: 0, hi: 75, step: 1, def: 12, group: 'diction' },
];

function oscSpecs(k, defaults) {
  const p = `osc${k}`;
  const oscillatorName = () => `${uiText("Осциллятор", "Oscillator")} ${k}`;
  return [
    {
      id: `${p}wave`,
      get label() { return `${oscillatorName()} · ${uiText("форма", "waveform")}`; },
      unit: '',
      lo: 0,
      hi: 4,
      step: 1,
      def: defaults.wave,
      group: 'voice',
      get names() { return [uiText("Синус", "Sine"), uiText("Треугольник", "Triangle"), uiText("Пила", "Sawtooth"), uiText("Пульс", "Pulse"), uiText("Шум", "Noise")]; },
    },
    { id: `${p}level`, get label() { return `${oscillatorName()} · ${uiText("уровень", "level")}`; }, unit: '%', lo: 0, hi: 100, step: 1, def: defaults.level, group: 'voice' },
    { id: `${p}oct`, get label() { return `${oscillatorName()} · ${uiText("октава", "octave")}`; }, get unit() { return uiText("окт", "oct"); }, lo: -3, hi: 3, step: 1, def: defaults.oct, group: 'voice' },
    { id: `${p}fine`, get label() { return `${oscillatorName()} · ${uiText("строй", "tuning")}`; }, unit: 'ct', lo: -100, hi: 100, step: 1, def: 0, group: 'voice' },
    { id: `${p}width`, get label() { return `${oscillatorName()} · ${uiText("ширина", "width")}`; }, unit: '%', lo: 3, hi: 97, step: 1, def: 34, group: 'voice' },
    {
      id: `${p}extra`,
      get label() { return `${oscillatorName()} · ${uiText("расширенная форма", "advanced waveform")}`; },
      unit: '',
      lo: 0,
      hi: 5,
      step: 1,
      def: 0,
      group: 'voice',
      get names() { return [uiText("Классическая", "Classic"), uiText("Орган", "Organ"), uiText("Колокол FM", "Bell FM"), uiText("Ступенчатая пила", "Stepped saw"), uiText("Тростниковый", "Reed"), uiText("Двойной импульс", "Double pulse")]; },
    },
  ];
}

function eqSpecs() {
  const freqs = [35, 140, 400, 1000, 2600, 6000, 17000];
  const names = () => [uiText("Срез низких", "Low cut"), uiText("Низкая полка", "Low shelf"), uiText("Средние 1", "Midrange 1"), uiText("Средние 2", "Midrange 2"), uiText("Средние 3", "Midrange 3"), uiText("Высокая полка", "High shelf"), uiText("Срез высоких", "High cut")];
  const out = [];
  for (let k = 0; k < 7; ++k) {
    const id = `b${k}`;
    const on = k !== 0 && k !== 6 ? 1 : 0;
    out.push({ id: `${id}on`, get label() { return names()[k]; }, unit: '', lo: 0, hi: 1, step: 1, def: on, group: 'eq', toggle: true });
    out.push({ id: `${id}freq`, get label() { return `${names()[k]} · ${uiText("частота", "frequency")}`; }, get unit() { return uiText("Гц", "Hz"); }, lo: 20, hi: 20000, step: 1, def: freqs[k], group: 'eq' });
    if (k > 0 && k < 6) {
      out.push({ id: `${id}gain`, get label() { return `${names()[k]} · ${uiText("усиление", "gain")}`; }, get unit() { return uiText("дБ", "dB"); }, lo: -18, hi: 18, step: 0.1, def: 0, group: 'eq' });
    }
    out.push({ id: `${id}q`, get label() { return `${names()[k]} · Q`; }, unit: '', lo: 0.15, hi: 10, step: 0.01, def: 0.71, group: 'eq' });
  }
  return out;
}

/** Значения по умолчанию для всех параметров. */
export function defaultParams() {
  const out = {};
  for (const s of SPECS) out[s.id] = s.def;
  return out;
}

export const DEFAULT_PARAMS = defaultParams();

export function specById(id) {
  return SPECS.find((s) => s.id === id) || null;
}

/** Готовые голоса: те же три заводских характера плюс нейтральный. */
export const FACTORY_VOICES = [
  { id: 0, get name() { return uiText("Нейтральный", "Neutral"); }, get hint() { return uiText("Базовый тембр без обработки", "Unprocessed base tone"); } },
  {
    id: 1,
    get name() { return uiText("Низкий", "Low"); },
    get hint() { return uiText("На октаву ниже, с шумом и сатурацией", "One octave lower, with noise and saturation"); },
    params: { pitch: -12, osc2wave: 4, osc2level: 14, sat: 1, drive: 8, filter: 1, cutoff: 1800 },
  },
  {
    id: 2,
    get name() { return uiText("Мягкий", "Soft"); },
    get hint() { return uiText("Синус, вибрато и реверберация", "Sine, vibrato and reverb"); },
    params: { osc1wave: 0, osc2wave: 1, attack: 12, release: 50, vib: 19, reverb: 1, revMix: 24 },
  },
  {
    id: 3,
    get name() { return uiText("Высокий", "High"); },
    get hint() { return uiText("На октаву выше, узкий импульс, биткрашер", "One octave higher, narrow pulse and bitcrushing"); },
    params: { pitch: 12, osc1width: 17, osc2fine: 22, crush: 1, bits: 5, crushRate: 6500, duration: 48 },
  },
];

export function factoryById(id) {
  return FACTORY_VOICES.find((v) => v.id === Number(id)) || FACTORY_VOICES[0];
}

/**
 * Голос персонажа → полный набор параметров.
 * voice = { preset, params } где params — только отличия.
 */
export function resolveParams(voice) {
  if (!voice) return { ...DEFAULT_PARAMS, ...(factoryById(0).params || {}) };

  // Полный набор параметров (ключи на верхнем уровне) — берём как есть поверх умолчаний.
  const isParamSet = SPECS.some((s) => s.id in voice);
  if (isParamSet) {
    const out = { ...DEFAULT_PARAMS, ...(factoryById(0).params || {}) };
    for (const s of SPECS) {
      if (!(s.id in voice)) continue;
      const num = Number(voice[s.id]);
      if (Number.isFinite(num)) out[s.id] = num;
    }
    return out;
  }

  const base = factoryById(voice.preset != null ? voice.preset : 0).params || {};
  const out = { ...DEFAULT_PARAMS, ...base };
  const overrides = voice.params || {};
  for (const key of Object.keys(overrides)) {
    if (!(key in out)) continue;
    const num = Number(overrides[key]);
    if (Number.isFinite(num)) out[key] = num;
  }
  return out;
}

/** Отличия полного набора от пресета — для сохранения в проект. */
export function diffFromPreset(params, preset) {
  const base = { ...DEFAULT_PARAMS, ...(factoryById(preset).params || {}) };
  const out = {};
  for (const s of SPECS) {
    const value = params[s.id];
    if (value === undefined) continue;
    if (Math.abs(Number(value) - Number(base[s.id])) > 1e-9) out[s.id] = Math.round(Number(value) * 100) / 100;
  }
  return out;
}

/** Человеческая подпись голоса: «Низкий · −12 st · 16 букв/с». */
export function describeVoice(voice) {
  const p = resolveParams(voice);
  const preset = factoryById(voice && voice.preset).name;
  const pitch = p.pitch ? `${p.pitch > 0 ? '+' : ''}${p.pitch} st` : uiText("без транспонирования", "no transposition");
  return `${preset} · ${pitch} · ${p.speed} ${uiText("букв/с", "chars/s")}`;
}

// — вкладки как в оригинальном плагине Dialogue Voice Studio:
//   -1 — верхний ряд (всегда на виду), 0 «Голос», 1 «Сэмпл», 2 «EQ», 3 «Эффекты», 4 «Диалог»,
//   5 — скрытые (расширенные формы волны выбираются прямо в списке формы осциллятора).
const MAIN_IDS = new Set(['pitch', 'duration', 'speed']);
const TAB_BY_GROUP = { voice: 0, sample: 1, eq: 2, fx: 3, diction: 4 };
for (const s of SPECS) {
  if (MAIN_IDS.has(s.id)) s.tab = -1;
  else if (s.id === 'osc1extra' || s.id === 'osc2extra') s.tab = 5;
  else s.tab = TAB_BY_GROUP[s.group] ?? 0;
}

/** Подписи пяти вкладок студии — в том же порядке, что в плагине. */
const tabNames = () => [uiText("Голос", "Voice"), uiText("Сэмпл", "Sample"), 'EQ', uiText("Эффекты", "Effects"), uiText("Диалог", "Dialogue")];

export let TABS = tabNames();
onLanguageChange(() => { TABS = tabNames(); });

/** Параметры верхнего ряда (высота, импульс, скорость). */
export const MAIN_SPECS = SPECS.filter((s) => s.tab === -1);

/** Параметры конкретной вкладки студии. */
export function specsForTab(tab) {
  return SPECS.filter((s) => s.tab === tab);
}
