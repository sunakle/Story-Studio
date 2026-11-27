import { t } from './i18n.js';
import { IMAGE_ACCEPT, filesToMedia, prepareImage } from './media.js';

export const CHAT_IMAGE_LIMIT = 4;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_ENCODED_IMAGE_CHARS = 3 * 1024 * 1024;
export const CHAT_IMAGE_CONTEXT_CHARS = CHAT_IMAGE_LIMIT * MAX_ENCODED_IMAGE_CHARS;
const rasterData = /^data:image\/(?:png|jpeg|webp|gif);base64,/;

export function validChatImage(image) {
  return typeof image?.data === 'string' && image.data.length <= MAX_ENCODED_IMAGE_CHARS && rasterData.test(image.data);
}

export function imageEndpoint(settings) {
  try {
    const url = new URL(settings.baseUrl);
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch { return ''; }
}

export function visionUnavailable(settings) {
  try {
    return new URL(settings.baseUrl).hostname === 'api.deepseek.com' && settings.model.trim() === 'deepseek-v4-pro';
  } catch { return false; }
}

export function imageRejection(message) {
  return /HTTP 415\b|(?:image|multimodal|vision|multi.modal|content\s+parts?).{0,110}(?:not support|unsupported|expected.*string|text.only|not allowed|invalid)|(?:unsupported|does not support|only supports?|not accept|invalid|unknown variant).{0,110}(?:image|multimodal|vision)|content.{0,80}(?:must|should|expected).{0,25}string/i.test(String(message));
}

export function imagesForProvider(message, settings) {
  if (message.imageEndpoint !== imageEndpoint(settings) || visionUnavailable(settings)) return [];
  return (Array.isArray(message.images) ? message.images : []).filter(validChatImage).slice(0, CHAT_IMAGE_LIMIT);
}

export function originText(message) {
  return message.origin ? '[StoryForge] ' + JSON.stringify(message.origin) + '\n' : '';
}

export function userMessageContent(message, settings) {
  const content = originText(message) + (message.content || '');
  const images = imagesForProvider(message, settings);
  if (!images.length) {
    if (!message.images?.length) return content;
    const note = t('[Фото из истории недоступно текущему подключению.]', '[Photo in chat history is unavailable to this connection.]');
    return [content, note].filter(Boolean).join('\n');
  }
  const parts = content ? [{ type: 'text', text: content }] : [];
  for (const image of images) parts.push({ type: 'image_url', image_url: { url: image.data } });
  return parts;
}

// Keep both model requests and the local history bounded without estimating
// text tokens from base64, which would crowd out the last entire conversation.
export function turnCost(turn, settings) {
  let text = 0, images = 0;
  for (const message of turn) {
    const { images: pictures, ...rest } = message;
    text += JSON.stringify(rest).length;
    if (Array.isArray(pictures)) {
      const eligible = settings ? imagesForProvider(message, settings) : pictures;
      for (const pic of eligible) images += pic.data?.length || 0;
    }
  }
  return { text, images };
}

export async function prepareChatImage(file) {
  if (!file || !IMAGE_ACCEPT.split(',').includes(file.type)) {
    throw new Error(t('Выберите изображение PNG, JPEG, WebP, GIF, BMP или AVIF.', 'Choose a PNG, JPEG, WebP, GIF, BMP or AVIF image.'));
  }
  if (file.size > MAX_INPUT_BYTES) throw new Error(t('Файл больше 20 МБ.', 'The file is larger than 20 MB.'));
  const [result] = await filesToMedia([file]);
  if (!result || result.error) throw new Error(result?.error || t('Не удалось прочитать изображение.', 'Could not read the image.'));
  if (!validChatImage(result)) throw new Error(t('Слишком большое изображение. Уменьшите его и повторите.', 'This image is too large. Resize it and try again.'));
  const thumb = await prepareImage(result, { maxEdge: 160, quality: 0.72 });
  return { name: result.name, data: result.data, thumb: thumb.data };
}

export function imageStrip(images, escape, removeIcon) {
  if (!Array.isArray(images)) return '';
  const items = images.filter(validChatImage).map((image, index) => {
    const name = escape(image.name || t('Изображение', 'Image'));
    const thumb = typeof image.thumb === 'string' && rasterData.test(image.thumb) ? image.thumb : image.data;
    const remove = removeIcon ? `<button type="button" class="chat-image-remove" data-remove-image="${index}" aria-label="${t('Убрать', 'Remove')} ${name}">${removeIcon}</button>` : '';
    return `<span class="chat-image" title="${name}"><img alt="${name}" src="${escape(thumb)}">${remove}</span>`;
  }).join('');
  return items ? `<div class="chat-images">${items}</div>` : '';
}
