import { t } from './i18n.js';
import { icon } from './icons.js';

export function createScreenplayEditor(store, ui) {
  let input, heading, convert, copy, renderedText;
  const save = ui.editAfterPause((text, baseline) => {
    if (store.project.screenplay !== baseline || text === baseline) return;
    const result = store.apply({ op: 'setScreenplay', text }, {
      label: t('Текст сценария', 'Screenplay text'), group: 'screenplay-typing',
    });
    if (result.ok) renderedText = text;
    else ui.toast(result.error, 'bad');
  });

  return function render(page, tab) {
    if (!input || !page.contains(input)) {
      page.innerHTML = `<article class="sf-screenplay">
        <header><h1 id="screenplayHeading"></h1><button type="button" class="wb-doc-action" data-screenplay-link>${icon('link', 15)}</button><button type="button" class="wb-doc-action" data-screenplay-chat>
          ${icon('branch', 15)}<span></span></button></header>
        <textarea id="screenplayText" spellcheck="true" aria-labelledby="screenplayHeading"></textarea>
      </article>`;
      input = page.querySelector('textarea');
      heading = page.querySelector('h1');
      convert = page.querySelector('[data-screenplay-chat]');
      copy = page.querySelector('[data-screenplay-link]');
      copy.onclick = () => ui.workbench.copyReferences();
      renderedText = store.project.screenplay;
      input.value = renderedText;
      input.setSelectionRange(tab.caretStart || 0, tab.caretEnd || 0);
      input.scrollTop = tab.textScroll || 0;
      input.onblur = () => {
        tab.caretStart = input.selectionStart;
        tab.caretEnd = input.selectionEnd;
        tab.textScroll = input.scrollTop;
      };
      input.oninput = () => {
        convert.disabled = !input.value.trim();
        save(input.value, renderedText);
      };
      convert.onclick = () => {
        ui.flushEdits();
        ui.setRightTab('ai');
        ui.ai?.focusInput(t(
          'Прочитай вкладку «Сценарий» целиком. Перенеси описанные сцены, персонажей, локации, реплики и варианты выбора в связанные ноды и разложи их на схеме. Сохрани ранее созданные элементы и сам текст сценария.',
          'Read the entire Screenplay tab. Turn its scenes, characters, locations, dialogue and choices into connected nodes and arrange them on the canvas. Keep existing elements and the original screenplay text.',
        ));
      };
    } else if (renderedText !== store.project.screenplay) {
      // Undo, redo and assistant edits update the open editor without moving focus.
      renderedText = store.project.screenplay;
      if (input.value !== renderedText) {
        const { selectionStart, selectionEnd, selectionDirection, scrollTop } = input;
        input.value = renderedText;
        input.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
        input.scrollTop = scrollTop;
      }
    }
    heading.textContent = t('Сценарий', 'Screenplay');
    copy.title = t('Скопировать ссылку на сценарий или выделенный текст', 'Copy link to the screenplay or selected text');
    copy.setAttribute('aria-label', copy.title);
    input.placeholder = t('Опишите первую сцену…', 'Write your first scene…');
    convert.querySelector('span').textContent = t('Создать ноды…', 'Create nodes…');
    convert.title = t('Подготовить запрос в чате AI', 'Prepare a request in AI chat');
    convert.disabled = !input.value.trim();
  };
}
