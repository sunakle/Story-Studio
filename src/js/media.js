import { t as uiText } from './i18n.js';
// Изображения узлов: выбор, уменьшение и подготовка data-URL для проекта.
// .sfproj остаётся самодостаточным файлом — картинки лежат в библиотеке проекта
// (project.media), поэтому приложение работает офлайн и проект переносится копией.

export const MEDIA_MAX_EDGE = 1400;
export const MEDIA_QUALITY = 0.82;
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif';

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} ${uiText("Б", "B")}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} ${uiText("КБ", "KB")}`;
  return `${(n / (1024 * 1024)).toFixed(1)} ${uiText("МБ", "MB")}`;
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(uiText("Не удалось прочитать изображение.", "Could not read image.")));
    img.src = dataUrl;
  });
}

function dataUrlSize(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  return Math.round(((dataUrl.length - comma - 1) * 3) / 4);
}

// Уменьшает картинку до MEDIA_MAX_EDGE по длинной стороне и перекодирует в WebP.
// Так .sfproj не раздувается от телефонных снимков.
export async function prepareImage(source, { maxEdge = MEDIA_MAX_EDGE, quality = MEDIA_QUALITY } = {}) {
  const data = String((source && source.data) || '');
  if (!data.startsWith('data:image/')) throw new Error(uiText("Ожидается изображение (data:image/…).", "Image expected (data:image/…)."));
  const img = await loadImage(data);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error(uiText("У изображения нулевой размер.", "Image has zero size."));

  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, outW, outH);

  let encoded = canvas.toDataURL('image/webp', quality);
  if (!encoded.startsWith('data:image/webp')) encoded = canvas.toDataURL('image/jpeg', 0.86);
  if (!encoded || encoded.length < 32) throw new Error(uiText("Не удалось перекодировать изображение.", "Could not encode image."));

  return {
    name: String((source && source.name) || 'image'),
    mime: encoded.slice(5, encoded.indexOf(';')),
    w: outW,
    h: outH,
    size: dataUrlSize(encoded),
    data: encoded,
  };
}

// Выбор файлов через нативный диалог (main-процесс читает файлы и отдаёт data-URL).
export async function pickImages() {
  if (!window.sf || !window.sf.media || !window.sf.media.pick) {
    throw new Error(uiText("Выбор файлов недоступен в этом окне.", "File selection is unavailable in this window."));
  }
  const res = await window.sf.media.pick();
  if (!res || res.ok === false) throw new Error((res && res.error) || uiText("Не удалось выбрать изображения.", "Could not select images."));
  const files = (res.files || []).filter((f) => f && String(f.data || '').startsWith('data:image/'));
  const prepared = [];
  for (const file of files) {
    try {
      prepared.push(await prepareImage(file));
    } catch (err) {
      prepared.push({ error: err && err.message ? err.message : String(err), name: file && file.name });
    }
  }
  return prepared;
}

// Файлы, брошенные в окно или вставленные из буфера обмена.
export async function filesToMedia(fileList) {
  const out = [];
  for (const file of Array.from(fileList || [])) {
    if (!file || !String(file.type || '').startsWith('image/')) continue;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error(`${uiText("Не удалось прочитать", "Could not read")} «${file.name}»`));
        reader.readAsDataURL(file);
      });
      out.push(await prepareImage({ name: file.name, data: dataUrl }));
    } catch (err) {
      out.push({ error: err && err.message ? err.message : String(err), name: file && file.name });
    }
  }
  return out;
}

// Рендерер не умеет читать байты из буфера обмена как файлы на всех платформах,
// поэтому вставку картинки разбираем через ClipboardEvent.clipboardData.files.
export function clipboardImages(event) {
  const data = event && event.clipboardData;
  if (!data) return [];
  const files = [];
  for (const item of Array.from(data.items || [])) {
    if (item && item.kind === 'file' && String(item.type || '').startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length) return files;
  return Array.from(data.files || []).filter((f) => String(f.type || '').startsWith('image/'));
}