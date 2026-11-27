import { t } from './i18n.js';
import { icon } from './icons.js';
import { validChatImage } from './chat-images.js';
import { prepareImage } from './media.js';
import { planArtworkEdit } from './ai-artwork.js';

export function composerPhotos(images, esc, namesOnly, locked) {
  if (!images.length) return '';
  const cards = images.map((image, index) => {
    if (!validChatImage(image)) return '';
    const name = esc(image.name || t('Изображение', 'Image'));
    const thumb = validChatImage({data:image.thumb}) ? image.thumb : image.data;
    return `<div class="composer-photo"><span class="chat-image"><img alt="${name}" src="${esc(thumb)}"></span>
      <span class="composer-photo-info"><span class="composer-photo-name" title="${name}">${name}</span>
      <button type="button" class="photo-canvas-action" data-photo-options="${index}" aria-haspopup="dialog" ${locked ? 'disabled' : ''}>${icon('layers',13)} ${t('На холст…','To canvas…')}</button></span>
      <button type="button" class="composer-photo-remove" data-remove-image="${index}" aria-label="${t('Убрать','Remove')} ${name}">${icon('close',12)}</button></div>`;
  }).join('');
  return `<div class="chat-images composer-photos">${cards}</div>
    <label class="local-photos-mode" title="${t('Фото останутся на этом ПК. Модель сможет использовать их в макете по имени.', 'Photos stay on this PC. The model can place them in a design by name.')}">
    <input type="checkbox" data-local-attachments ${namesOnly ? 'checked' : ''} ${locked ? 'disabled' : ''}> ${t('Передать модели только имена файлов', 'Send only the filenames to the model')}</label>`;
}

export function choosePhotoPlacement(image, ui, insert) {
  const name = ui.escapeHTML(image.name || t('Изображение', 'Image'));
  const thumb = validChatImage({data:image.thumb}) ? image.thumb : image.data;
  const body = ui.el(`<div class="photo-placement">
    <div class="photo-placement-file"><img alt="" src="${ui.escapeHTML(thumb)}"><strong>${name}</strong></div>
    <button type="button" data-place="still">${icon('layers',18)}<span>${t('Вставить изображение','Insert image')}</span></button>
    <button type="button" data-place="bounce">${icon('play',18)}<span>${t('Вставить с отскоком','Insert with bounce')}</span></button>
  </div>`);
  const dialog = ui.modal({title:t('На холст ИИ-мастерской','Place on the AI studio canvas'),body});
  body.closest('.modal-card').classList.add('photo-placement-dialog');
  body.addEventListener('click', event => {
    const button = event.target.closest('[data-place]');
    if (!button) return;
    dialog.close();
    insert(button.dataset.place === 'bounce');
  });
  body.querySelector('button').focus();
}

export async function placeComposerPhoto({image, bounce, store, ui, current}) {
  if (!validChatImage(image)) throw Error(t('Изображение недоступно.', 'The image is unavailable.'));
  const workbench = ui.workbench, workspaceId = workbench.assistantWorkspaceId();
  const origin = workbench.assistantContext();
  const pageId = origin.workspaceId === workspaceId ? origin.pageId : undefined;
  let media = image;
  // Stored chat photos are already normalized; use their exact pixels where possible.
  if (!image.w || !image.h || !/^data:image\/(png|jpeg|webp);base64,/.test(image.data)) {
    media = await prepareImage(image);
  }
  if (!current()) return false;
  if (!await workbench.flushDesigns()) throw Error(t('Не удалось синхронизировать холст.', 'Could not synchronize the canvas.'));
  if (!current()) return false;
  const project = store.project;
  const design = project.gigmaWorkspaces.find(w => w.id === workspaceId)?.document;
  const page = design?.pages.find(p => p.id === (pageId || design.activePageId));
  const x = page?.nodes.length ? Math.ceil(Math.max(...page.nodes.map(n => n.x + n.width))) + 24 : 0;
  const plan = planArtworkEdit(project, {action:'create',kind:'image',workspaceId,pageId,
    name:(image.name || t('Изображение', 'Image')).slice(0,160),x,y:0,width:media.w,height:media.h,imageData:media.data,
    ...(bounce && {animation:{type:'bounce',durationMs:1100,loop:true}})});
  const result = store.apply(plan.ops,{label:bounce ? t('Вставить фото с отскоком','Insert photo with bounce') : t('Вставить фото на холст','Insert photo on canvas')});
  if (!result.ok) throw Error(result.error);
  workbench.openAssistant();
  workbench.revealWorkshopLayer({workspaceId, pageId:plan.pageId, objectId:plan.objectIds[0], playAnimation:bounce});
  return true;
}
