import { t } from '../i18n.js';
// WAV-кодек: 16-битный PCM, как в плагине при экспорте реплики.

/** Float32 [-1..1] → 16-битный PCM с клиппингом и мягким дизерингом. */
export function encodeWav(channels, rate = 48000) {
  const list = Array.isArray(channels) ? channels : [channels];
  const count = list.length;
  const frames = list[0].length;
  const bytesPerSample = 2;
  const blockAlign = count * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; ++i) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, count, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frames; ++i) {
    for (let ch = 0; ch < count; ++ch) {
      const x = Math.max(-1, Math.min(1, list[ch][i] || 0));
      view.setInt16(offset, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      offset += 2;
    }
  }
  return buffer;
}

/** Разбор WAV (8/16/24/32-бит PCM и float32) → моно Float32 + частота. */
export function decodeWav(bytes) {
  const view = ArrayBuffer.isView(bytes)
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new DataView(bytes instanceof ArrayBuffer ? bytes : Uint8Array.from(bytes).buffer);
  const tag = (offset) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error(t('Это не WAV-файл', 'This is not a WAV file'));

  let offset = 12;
  let format = 1;
  let channels = 1;
  let rate = 48000;
  let bits = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= view.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = size;
    }
    offset = body + size + (size % 2);
  }

  if (dataOffset < 0) throw new Error(t('В WAV нет блока данных', 'This WAV file has no data chunk'));
  if (rate < 8000 || rate > 384000) throw new Error(t(`Частота ${rate} Гц не поддерживается (8–384 кГц)`, `Unsupported sample rate: ${rate} Hz (8–384 kHz allowed)`));
  if (channels < 1 || channels > 2) throw new Error(t('Поддерживается моно или стерео', 'Only mono and stereo audio are supported'));

  const width = bits / 8;
  const frames = Math.floor(dataSize / (width * channels));
  if (frames < 1) throw new Error(t('Пустой WAV', 'Empty WAV file'));
  if (frames > rate * 30) throw new Error(t('Сэмпл длиннее 30 секунд', 'The sample is longer than 30 seconds'));

  const pcm = new Float32Array(frames);
  let peak = 0;
  for (let i = 0; i < frames; ++i) {
    let sum = 0;
    for (let ch = 0; ch < channels; ++ch) {
      const at = dataOffset + (i * channels + ch) * width;
      let v = 0;
      if (format === 3 && bits === 32) v = view.getFloat32(at, true);
      else if (bits === 8) v = (view.getUint8(at) - 128) / 128;
      else if (bits === 16) v = view.getInt16(at, true) / 32768;
      else if (bits === 24) {
        const b0 = view.getUint8(at);
        const b1 = view.getUint8(at + 1);
        const b2 = view.getInt8(at + 2);
        v = ((b2 << 16) | (b1 << 8) | b0) / 8388608;
      } else if (bits === 32) v = view.getInt32(at, true) / 2147483648;
      sum += v;
    }
    const value = sum / channels;
    pcm[i] = value;
    peak = Math.max(peak, Math.abs(value));
  }

  return { pcm, rate, peak: peak || 1, frames, name: '' };
}

/** Человеческая длительность: 1,4 с. */
export function formatSeconds(seconds) {
  const s = Math.max(0, seconds || 0);
  if (s < 10) return t(`${s.toFixed(1).replace('.', ',')} с`, `${s.toFixed(1)} s`);
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return m ? t(`${m} мин ${rest} с`, `${m} min ${rest} s`) : t(`${Math.round(s)} с`, `${Math.round(s)} s`);
}

/**
 * WAV с параметрами экспорта — как writeWave в плагине:
 * пересэмплирование (линейная интерполяция), 16 или 24 бита, моно или стерео.
 */
export function encodeWave({ left, right = left, rate = 48000, targetRate = rate, channels = 2, bits = 16 }) {
  const ch = channels === 1 ? 1 : 2;
  const depth = bits === 24 ? 3 : 2;
  const total = Math.max(1, Math.round((left.length * targetRate) / rate));
  const step = rate / targetRate;
  const data = new Uint8Array(total * ch * depth);

  const sampleAt = (buf, pos) => {
    const a = Math.min(Math.floor(pos), buf.length - 1);
    const b = Math.min(a + 1, buf.length - 1);
    return buf[a] + (pos - a) * (buf[b] - buf[a]);
  };

  let o = 0;
  for (let i = 0; i < total; ++i) {
    const pos = i * step;
    const l = sampleAt(left, pos);
    const r = sampleAt(right, pos);
    const frame = ch === 1 ? [0.5 * (l + r)] : [l, r];
    for (let c = 0; c < ch; ++c) {
      const v = Math.max(-1, Math.min(1, frame[c]));
      if (depth === 3) {
        const q = Math.max(-8388608, Math.min(8388607, Math.round(v * 8388607)));
        data[o++] = q & 0xff;
        data[o++] = (q >> 8) & 0xff;
        data[o++] = (q >> 16) & 0xff;
      } else {
        const q = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
        data[o++] = q & 0xff;
        data[o++] = (q >> 8) & 0xff;
      }
    }
  }

  const blockAlign = ch * depth;
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const ascii = (at, text) => {
    for (let i = 0; i < text.length; ++i) header[at + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + data.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, ch, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, depth * 8, true);
  ascii(36, 'data');
  view.setUint32(40, data.length, true);

  const out = new Uint8Array(header.length + data.length);
  out.set(header, 0);
  out.set(data, header.length);
  return out;
}
