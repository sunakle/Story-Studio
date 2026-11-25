import { getLanguage } from '../i18n.js';
import { renderBlocks } from './render.js';
import { encodeWave, encodeWav } from './wav.js';

export function finishRender(take, wav) {
  if (!wav) return take;
  const bytes = wav === true
    ? new Uint8Array(encodeWav([take.left, take.right], take.rate))
    : encodeWave({ ...take, ...wav });
  return { bytes, seconds: take.seconds };
}

// file:// Chromium environments differ in module Worker support. Keep the same
// DSP in short slices if a worker cannot start. A DSP error remains an error.
async function cooperative(options, wav, signal) {
  const blocks = renderBlocks(options);
  while (true) {
    signal?.throwIfAborted();
    const start = performance.now();
    do {
      const block = blocks.next();
      if (block.done) return finishRender(block.value, wav);
    } while (performance.now() - start < 6);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

export async function synthesize(options, { wav, signal } = {}) {
  signal?.throwIfAborted();
  let worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch {
    return cooperative(options, wav, signal);
  }
  const result = await new Promise((resolve, reject) => {
    const abort = () => finish(reject, signal.reason);
    const finish = (fn, value) => {
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      fn(value);
    };
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = event => {
      event.preventDefault();
      finish(resolve, null);
    };
    worker.onmessage = ({ data }) => data.error
      ? finish(reject, new Error(data.error))
      : finish(resolve, data.value);
    try {
      worker.postMessage({ options, wav, language: getLanguage() });
    } catch (error) {
      finish(reject, error);
    }
  });
  return result ?? cooperative(options, wav, signal);
}
