import { t } from './i18n.js';

export function imageFields(settings, escape) {
  return `<details class="modal-section">
    <summary>${t('Генерация изображений', 'Image generation')}</summary>
    <p class="hint-text">${t('Подключите сервис с API Images. Ключ чата можно использовать для того же сервера. Запросы оплачиваются по тарифу сервиса.', 'Connect an Images API provider. The chat key can be used on the same server. Provider rates apply.')}</p>
    <label class="field"><span class="field-label">${t('Адрес API изображений', 'Image API base URL')}</span>
      <input class="input" data-image-setting="imageBaseUrl" value="${escape(settings.imageBaseUrl)}" placeholder="https://api.openai.com/v1"></label>
    <label class="field"><span class="field-label">${t('Модель изображений', 'Image model')}</span>
      <input class="input" data-image-setting="imageModel" value="${escape(settings.imageModel)}" placeholder="gpt-image-1"></label>
    <label class="field"><span class="field-label">${t('Ключ сервиса изображений', 'Image service key')}</span>
      <input class="input" type="password" autocomplete="off" data-image-setting="imageApiKey" value="${escape(settings.imageApiKey)}"></label>
  </details>`;
}

export function readImageFields(root) {
  return Object.fromEntries(Array.from(root.querySelectorAll('[data-image-setting]'), el => [el.dataset.imageSetting, el.value.trim()]));
}
