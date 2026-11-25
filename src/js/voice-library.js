import { t } from './i18n.js';

function errorText(code) {
  if (code === 'INVALID_NAME') return t('Введите название от 1 до 120 символов.', 'Enter a name between 1 and 120 characters.');
  if (code === 'INVALID_VOICE') return t('Не удалось прочитать настройки или образец голоса.', 'The voice settings or audio sample could not be read.');
  if (code === 'INVALID_ENTRY' || code === 'ENOENT') return t('Сохранённый голос недоступен.', 'The saved voice is unavailable.');
  return t('Не удалось прочитать или записать библиотеку голосов.', 'The voice library could not be read or saved.');
}

export function openVoiceLibrary({ ui, readVoice, applyVoice, suggestedName }) {
  const library = window.sf.voiceLibrary;
  const body = ui.el(`
    <div class="voice-library-body">
      <div class="field">
        <label class="field-label" for="voice-library-entries">${t('Сохранённые голоса', 'Saved voices')}</label>
        <div class="field-row"><select id="voice-library-entries"></select>
          <button class="btn" type="button" data-action="apply">${t('Применить', 'Apply')}</button></div>
      </div>
      <div class="field">
        <label class="field-label" for="voice-library-name">${t('Сохранить текущий голос под именем', 'Save current voice as')}</label>
        <div class="field-row"><input id="voice-library-name" type="text" maxlength="120">
          <button class="btn" type="button" data-action="save">${t('Сохранить', 'Save')}</button></div>
      </div>
      <div class="hint-text" role="status" aria-live="polite"></div>
      <div class="field-row" data-confirm hidden>
        <button class="btn" type="button" data-action="replace">${t('Заменить сохранённый голос', 'Replace saved voice')}</button>
        <button class="btn" type="button" data-action="cancel">${t('Отмена', 'Cancel')}</button>
      </div>
    </div>`);
  const entries = body.querySelector('select');
  const name = body.querySelector('input');
  const status = body.querySelector('[role="status"]');
  const confirmation = body.querySelector('[data-confirm]');
  const button = action => body.querySelector('[data-action="' + action + '"]');
  const generation = ui.store.generation;
  const snapshot = structuredClone(readVoice());
  name.value = (suggestedName || '').slice(0, name.maxLength);
  let active = true, busy = false, duplicateId = '';
  const dialog = ui.modal({ title: t('Библиотека голосов', 'Voice library'), body, onClose: () => { active = false; } });
  const card = dialog.body.closest('.modal-card');
  card.tabIndex = -1;
  card.focus();
  function sync() {
    entries.disabled = busy || !entries.value;
    button('apply').disabled = entries.disabled;
    name.disabled = busy;
    button('save').disabled = busy || !name.value.trim() || !!duplicateId;
    confirmation.hidden = !duplicateId;
    button('replace').disabled = busy;
    button('cancel').disabled = busy;
  }
  async function run(action) {
    if (busy || !active) return;
    const focused = document.activeElement;
    busy = true;
    sync();
    if (focused.disabled) card.focus();
    try { await action(); }
    catch (error) { if (active) status.textContent = errorText(error.code); }
    finally {
      busy = false;
      if (active) {
        sync();
        if (document.activeElement === card) {
          const previous = focused !== card && !focused.disabled && focused.getClientRects().length;
          const fallback = duplicateId ? button('cancel') : entries.disabled ? name : entries;
          (previous ? focused : fallback).focus();
        }
      }
    }
  }
  async function refresh(preferred) {
    const result = await library.list();
    if (!active) return;
    if (!result.ok) throw result;
    entries.replaceChildren(...result.entries.map(v => new Option(v.name, v.id)));
    if (!entries.length) entries.add(new Option(t('Пока нет сохранённых голосов', 'No saved voices yet'), ''));
    if (preferred) entries.value = preferred;
  }
  const save = replaceId => run(async () => {
    const result = await library.save(name.value, snapshot, replaceId);
    if (!active) return;
    if (result.code === 'DUPLICATE') {
      duplicateId = result.id;
      status.textContent = t('Голос с таким именем уже существует. Заменить его?', 'A voice with this name already exists. Replace it?');
      return;
    }
    if (!result.ok) throw result;
    duplicateId = '';
    status.textContent = t('Голос сохранён в библиотеке.', 'Voice saved to the library.');
    await refresh(result.id);
  });
  button('save').onclick = () => save();
  button('replace').onclick = () => save(duplicateId);
  const resetConfirmation = () => { duplicateId = ''; status.textContent = ''; sync(); };
  name.oninput = resetConfirmation;
  name.onkeydown = event => {
    if (event.key === 'Enter' && !button('save').disabled) { event.preventDefault(); save(); }
  };
  button('cancel').onclick = () => { resetConfirmation(); name.focus(); };
  button('apply').onclick = () => run(async () => {
    const result = await library.load(entries.value);
    if (!active) return;
    if (!result.ok) throw result;
    if (generation !== ui.store.generation || !applyVoice(result.voice)) {
      status.textContent = t('Цель для голоса изменилась. Откройте библиотеку снова.', 'The voice target changed. Reopen the library.');
      return;
    }
    dialog.close();
    ui.toast(t('Голос применён.', 'Voice applied.'));
  });
  card.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); dialog.close(); }
  });
  run(() => refresh());
  return dialog;
}
