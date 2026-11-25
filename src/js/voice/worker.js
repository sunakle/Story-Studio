import { setLanguage } from '../i18n.js';
import { renderLine } from './render.js';
import { finishRender } from './job.js';

self.onmessage = ({ data }) => {
  try {
    setLanguage(data.language);
    const value = finishRender(renderLine(data.options), data.wav);
    const transfer = value.bytes ? [value.bytes.buffer] : [value.left.buffer, value.right.buffer];
    self.postMessage({ value }, transfer);
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
