// Самотест движка озвучки: рендер реплики, длительность, тишина, WAV-круговорот.
// Запуск: node tools/_selftest-voice.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = async (rel) => import(new URL(`file://${join(root, rel).replace(/\\/g, '/')}`).href);

const { renderLine, peakOf, Engine } = await load('src/js/voice/render.js');
const { encodeWav, encodeWave, decodeWav, formatSeconds } = await load('src/js/voice/wav.js');
const { defaultParams, FACTORY_VOICES, resolveParams, SPECS, describeVoice, factoryById, diffFromPreset, TABS, specsForTab, MAIN_SPECS } = await load('src/js/voice/params.js');
const { waveform, Biquad, Reverb, Noise, db, clamp, eqResponseDb, bandCoeffs } = await load('src/js/voice/dsp.js');

let pass = 0;
const fails = [];
const ok = (name, cond, info = '') => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${info ? ' — ' + info : ''}`);
  } else {
    fails.push(`${name}${info ? ' — ' + info : ''}`);
    console.log(`  FAIL ${name}${info ? ' — ' + info : ''}`);
  }
};

console.log('1. параметры');
const p = defaultParams();
ok('defaultParams возвращает объект с pitch', typeof p.pitch === 'number', `pitch=${p.pitch}`);
ok('SPECS непустой', SPECS.length > 60, `${SPECS.length} параметров`);
ok('все параметры из SPECS имеют значение по умолчанию', SPECS.every((s) => p[s.id] !== undefined), '');
ok('заводских характеров 4', FACTORY_VOICES.length === 4, FACTORY_VOICES.map((v) => v.name).join(', '));
ok('resolveParams(null) = нейтральный', resolveParams(null).pitch === p.pitch, `pitch=${resolveParams(null).pitch}`);
const low = resolveParams({ preset: 1 });
ok('пресет «Низкий» опускает на октаву', low.pitch === -12, `pitch=${low.pitch}`);
ok('factoryById(2) даёт «Мягкий»', factoryById(2).name === 'Мягкий', factoryById(2).name);
ok('diffFromPreset пуст для самого пресета', Object.keys(diffFromPreset(resolveParams({ preset: 1 }), 1)).length === 0, '');
ok('diffFromPreset ловит отличия', diffFromPreset({ ...resolveParams({ preset: 1 }), pitch: 3 }, 1).pitch === 3, '');
ok('describeVoice даёт текст', typeof describeVoice({ preset: 1 }) === 'string' && describeVoice({ preset: 1 }).length > 3, describeVoice({ preset: 1 }));

console.log('2. DSP');
ok('db(0)=1', Math.abs(db(0) - 1) < 1e-9, '');
ok('db(-6)≈0.5', Math.abs(db(-6) - 0.5011) < 0.01, db(-6).toFixed(4));
ok('clamp держит границы', clamp(5, 0, 1) === 1 && clamp(-5, 0, 1) === 0, '');
const n1 = new Noise(42);
const n2 = new Noise(42);
ok('Noise детерминирован', n1.next() === n2.next(), '');
ok('Noise в диапазоне [-1,1]', Array.from({ length: 200 }, () => n1.next()).every((v) => v >= -1 && v <= 1), '');
let wavePeak = 0;
for (let i = 0; i < 10; ++i) {
  const ph = (i / 10) % 1;
  wavePeak = Math.max(wavePeak, Math.abs(waveform(i % 10, ph, 0.34, 30, n1)));
}
ok('waveform выдаёт сигнал', wavePeak > 0.01, `peak=${wavePeak.toFixed(3)}`);
const bq = new Biquad();
bq.lowPass(48000, 1000, 0.7);
let bqOut = 0;
for (let i = 0; i < 480; ++i) bqOut += Math.abs(bq.tick(Math.sin((i / 48000) * 2 * Math.PI * 200)));
ok('Biquad фильтрует (не NaN)', Number.isFinite(bqOut) && bqOut > 0, bqOut.toFixed(3));
const rv = new Reverb();
rv.setSampleRate(48000);
rv.setParameters({ roomSize: 0.5, damping: 0.5, wetLevel: 0.3, dryLevel: 0.7, width: 1 });
const [rl, rr] = rv.processStereo(0.5, 0.5);
ok('Reverb возвращает пару чисел', Number.isFinite(rl) && Number.isFinite(rr), `${rl.toFixed(3)}/${rr.toFixed(3)}`);

console.log('3. рендер реплики');
const t0 = Date.now();
const line = renderLine({ params: defaultParams(), text: 'Привет, мир!', seed: 7, mode: 'line' });
const ms = Date.now() - t0;
ok('рендер вернул каналы', line.left.length > 0 && line.left.length === line.right.length, `${line.left.length} сэмплов`);
ok('длительность в разумных пределах', line.seconds > 0.3 && line.seconds < 12, formatSeconds(line.seconds));
ok('сигнал не тишина', peakOf(line) > 0.02, `peak=${peakOf(line).toFixed(3)}`);
ok('нет NaN в выборке', line.left.every((v) => Number.isFinite(v)), '');
ok('нет выхода за ±1.5', peakOf(line) < 1.5, `peak=${peakOf(line).toFixed(3)}`);
ok('reveal по числу символов', line.reveal.length === 'Привет, мир!'.length, `${line.reveal.length}`);
ok('reveal возрастает', line.reveal.every((v, i, a) => i === 0 || v >= a[i - 1]), '');
ok('рендер быстрый (< 3 с)', ms < 3000, `${ms} мс`);

const longText = 'Она вошла в комнату, не сказав ни слова... И только потом, спустя минуту, спросила: «Ты здесь?»';
const longLine = renderLine({ params: defaultParams(), text: longText, seed: 11, mode: 'line' });
ok('длинная реплика рендерится', longLine.seconds > line.seconds, `${formatSeconds(longLine.seconds)} против ${formatSeconds(line.seconds)}`);

const slow = renderLine({ params: { ...defaultParams(), speed: 8 }, text: 'Привет, мир!', seed: 7, mode: 'line' });
const fast = renderLine({ params: { ...defaultParams(), speed: 40 }, text: 'Привет, мир!', seed: 7, mode: 'line' });
ok('медленная речь длиннее быстрой', slow.seconds > fast.seconds, `${formatSeconds(slow.seconds)} против ${formatSeconds(fast.seconds)}`);

const a1 = renderLine({ params: defaultParams(), text: 'Проверка разброса', seed: 3, mode: 'line' });
const a2 = renderLine({ params: defaultParams(), text: 'Проверка разброса', seed: 3, mode: 'line' });
ok('один seed → одинаковый рендер', peakOf(a1) === peakOf(a2), `peak=${peakOf(a1).toFixed(4)}`);

const pulse = renderLine({ params: defaultParams(), text: '', seed: 5, mode: 'pulse' });
ok('режим «импульс» рендерит один слог', pulse.seconds > 0.02 && pulse.seconds < 2, formatSeconds(pulse.seconds));

let tooLong = false;
try {
  renderLine({ params: { ...defaultParams(), speed: 1, every: 1 }, text: 'а'.repeat(600), seed: 1, mode: 'line' });
} catch (err) {
  tooLong = /90/.test(err.message);
}
ok('реплика длиннее 90 с даёт понятную ошибку', tooLong, '');

console.log('4. WAV');
const wav = encodeWav([line.left, line.right], line.rate);
ok('WAV-заголовок RIFF/WAVE', new DataView(wav).getUint32(0, false) === 0x52494646, '');
ok('WAV 2 канала 48000', new DataView(wav).getUint16(22, true) === 2 && new DataView(wav).getUint32(24, true) === 48000, '');
ok('размер WAV = 44 + 4·кадров', wav.byteLength === 44 + line.left.length * 4, `${(wav.byteLength / 1024).toFixed(1)} КБ`);
const back = decodeWav(wav);
ok('декодирование возвращает кадры', back.frames === line.left.length, `${back.frames}`);
ok('частота сохраняется', back.rate === line.rate, `${back.rate}`);
ok('амплитуда после круга ≈ исходная', Math.abs(back.peak - peakOf(line)) < 0.02, `${back.peak.toFixed(3)} против ${peakOf(line).toFixed(3)}`);
ok('formatSeconds(75) = «1 мин 15 с»', formatSeconds(75) === '1 мин 15 с', formatSeconds(75));

const sample = { pcm: new Float32Array(4800).map((_, i) => Math.sin((i / 48000) * 2 * Math.PI * 220)), rate: 48000, peak: 1, frames: 4800, name: 'тест' };
const withSample = renderLine({ params: { ...defaultParams(), source: 2 }, sample, text: 'С сэмплом', seed: 9, mode: 'line' });
ok('рендер с сэмплом работает', peakOf(withSample) > 0.01, `peak=${peakOf(withSample).toFixed(3)}`);

console.log('5. движок');
const eng = new Engine(48000);
eng.configure(defaultParams(), null, false);
eng.on(60, 1, 123);
let engPeak = 0;
for (let i = 0; i < 4800; ++i) {
  const [l, r] = eng.tick();
  engPeak = Math.max(engPeak, Math.abs(l), Math.abs(r));
}
ok('Engine.tick даёт сигнал', engPeak > 0.001, `peak=${engPeak.toFixed(3)}`);

console.log('6. студия (вкладки, выделение, вариации, формат WAV, EQ)');
ok('TABS: пять вкладок с русскими названиями', TABS.length === 5 && TABS.join('|') === 'Голос|Сэмпл|EQ|Эффекты|Диалог', TABS.join(', '));
const byTab = (n) => specsForTab(n).length;
ok('вкладка «Голос»: 19 параметров', byTab(0) === 19, `${byTab(0)}`);
ok('вкладка «Сэмпл»: 8 параметров', byTab(1) === 8, `${byTab(1)}`);
ok('вкладка «EQ»: 27 параметров', byTab(2) === 27, `${byTab(2)}`);
ok('вкладка «Эффекты»: 33 параметра', byTab(3) === 33, `${byTab(3)}`);
ok('вкладка «Диалог»: 6 параметров', byTab(4) === 6, `${byTab(4)}`);
ok('верхний ряд: 3 параметра', byTab(-1) === 3, `${byTab(-1)}`);
ok('скрытые формы волны: 2 параметра', byTab(5) === 2, `${byTab(5)}`);
const tabSum = [0, 1, 2, 3, 4, 5, -1].reduce((acc, n) => acc + byTab(n), 0);
ok('вкладки покрывают все SPECS без потерь', tabSum === SPECS.length, `${tabSum} из ${SPECS.length}`);
ok('MAIN_SPECS: три контрола верхнего ряда', MAIN_SPECS.length === 3, MAIN_SPECS.map((s) => s.id).join(','));

const trimSample = { pcm: new Float32Array(4800).map((_, i) => Math.sin((i / 48000) * 2 * Math.PI * 220)), rate: 48000, peak: 1, frames: 4800, name: 'trim' };
const sel = renderLine({ params: { ...defaultParams(), source: 1, start: 10, end: 40 }, sample: trimSample, text: '', seed: 4, mode: 'selection' });
ok('режим выделения рендерит короткий фрагмент', sel.seconds > 0.02 && sel.seconds < 0.6, formatSeconds(sel.seconds));
ok('режим выделения даёт звук', peakOf(sel) > 0.001, `peak=${peakOf(sel).toFixed(3)}`);
let selNoSample = false;
try {
  renderLine({ params: { ...defaultParams(), source: 1 }, text: '', seed: 4, mode: 'selection' });
} catch (err) {
  selNoSample = true;
}
ok('выделение без сэмпла не падает', !selNoSample, selNoSample ? 'исключение' : '');
const varm = renderLine({ params: { ...defaultParams(), spread: 12, jitter: 40 }, text: '', seed: 8, mode: 'variation' });
ok('режим вариации рендерит один слог', varm.seconds > 0.02 && varm.seconds < 2, formatSeconds(varm.seconds));

const stereo = encodeWave({ left: line.left, right: line.right, rate: line.rate, targetRate: 44100, channels: 2, bits: 16 });
const sdv = new DataView(stereo.buffer, stereo.byteOffset, stereo.byteLength);
ok('encodeWave: 2 канала / 16 бит / 44100', sdv.getUint16(22, true) === 2 && sdv.getUint16(34, true) === 16 && sdv.getUint32(24, true) === 44100, '');
ok('encodeWave: размер = 44 + кадры·4', stereo.byteLength === 44 + Math.round(line.left.length * 44100 / line.rate) * 4, `${(stereo.byteLength / 1024).toFixed(1)} КБ`);
const mono24 = encodeWave({ left: line.left, rate: line.rate, targetRate: 48000, channels: 1, bits: 24 });
const mdv = new DataView(mono24.buffer, mono24.byteOffset, mono24.byteLength);
ok('encodeWave: моно / 24 бита', mdv.getUint16(22, true) === 1 && mdv.getUint16(34, true) === 24, '');
ok('encodeWave: моно 24 бита = 44 + кадры·3', mono24.byteLength === 44 + line.left.length * 3, '');

const flat = eqResponseDb({ eq: 0 }, 1000);
ok('eqResponseDb выключен → 0 дБ', Math.abs(flat) < 1e-9, `${flat}`);
const boosted = eqResponseDb({ eq: 1, b2on: 1, b2freq: 1000, b2gain: 6, b2q: 1 }, 1000);
ok('eqResponseDb с усилением средней полосы > 0', boosted > 0.5, `${boosted.toFixed(2)} дБ`);
const coeffs = bandCoeffs({ eq: 1, b2on: 1, b2freq: 1000, b2gain: 6, b2q: 1 }, 2, 48000);
ok('bandCoeffs возвращает конечные коэффициенты', ['b0', 'b1', 'b2', 'a1', 'a2'].every((k) => Number.isFinite(coeffs[k])), '');

console.log('');
if (fails.length) {
  console.log(`ПРОВАЛЕНО ${fails.length} из ${pass + fails.length}:`);
  for (const f of fails) console.log('  · ' + f);
  process.exit(1);
}
console.log(`ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ (${pass})`);
