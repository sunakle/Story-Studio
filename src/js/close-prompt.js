import { t } from './i18n.js';

// Native <dialog> keeps keyboard focus and mouse input inside the prompt,
// including when the window's close button is pressed over another editor modal.
export function askBeforeClosing(projectTitle) {
  const dialog = document.createElement('dialog');
  dialog.className = 'close-prompt';
  dialog.setAttribute('aria-labelledby', 'closePromptTitle');
  dialog.setAttribute('aria-describedby', 'closePromptProject');
  dialog.innerHTML = `
    <header class="close-prompt-bar">
      <img src="./assets/storyforge-mark.png" alt="" width="18" height="18" />
      <span>StoryForge</span>
      <button type="button" data-choice="cancel" aria-label="${t('Отмена', 'Cancel')}" class="close-prompt-x">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="m3.5 3.5 9 9m0-9-9 9" fill="none" stroke="currentColor" stroke-width="1.25" />
        </svg>
      </button>
    </header>
    <div class="close-prompt-content">
      <h2 id="closePromptTitle">${t('Сохранить изменения?', 'Save changes?')}</h2>
      <p id="closePromptProject"></p>
    </div>
    <footer class="close-prompt-actions">
      <button type="button" data-choice="save">${t('Сохранить', 'Save')}</button>
      <button type="button" data-choice="discard">${t('Не сохранять', 'Don’t save')}</button>
      <button type="button" data-choice="cancel" autofocus>${t('Отмена', 'Cancel')}</button>
    </footer>`;
  const title = projectTitle || t('Без названия', 'Untitled');
  dialog.querySelector('#closePromptProject').textContent = t(
    `В проекте «${title}» есть несохранённые изменения.`,
    `“${title}” has unsaved changes.`
  );
  const previousFocus = document.activeElement;
  return new Promise(resolve => {
    function finish(choice) {
      dialog.close();
      dialog.remove();
      previousFocus?.focus({ preventScroll: true });
      resolve(choice);
    }
    dialog.addEventListener('click', event => {
      const button = event.target.closest('button[data-choice]');
      if (button) finish(button.dataset.choice);
    });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      finish('cancel');
    });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('[autofocus]').focus();
  });
}

