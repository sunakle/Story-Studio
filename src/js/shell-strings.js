import { t } from './i18n.js';
// Labels belonging to the initial HTML shell. Project content is rendered separately.
export const shellStrings = {
  "Инструменты рабочего места": "Workspace tools",
  "Показать или скрыть проводник": "Show or hide explorer",
  "Быстрый переход (Ctrl+K)": "Quick switcher (Ctrl+K)",
  "Обзор сюжета (Ctrl+Shift+G)": "Story overview (Ctrl+Shift+G)",
  "Схема переходов": "Story flow",
  "Таблица сценария": "Story table",
  "Заметка за сегодня": "Today's note",
  "Пройти ветку": "Play branch",
  "Команды проекта": "Project commands",
  "StoryForge — Меню проекта": "StoryForge — Project menu",
  "Переключить тему": "Switch theme",
  "Настройки": "Settings",
  "Проводник проекта": "Project explorer",
  "Разделы проекта": "Project sections",
  "Сценарий (Ctrl+1)": "Story (Ctrl+1)",
  "Поиск по проекту (Ctrl+F)": "Search project (Ctrl+F)",
  "Закладки": "Bookmarks",
  "Другие разделы проекта": "More project sections",
  "StoryForge — Файл и недавние проекты": "StoryForge — File and recent projects",
  "Название проекта — нажмите, чтобы изменить": "Project name — click to edit",
  "Название проекта": "Project title",
  "Есть несохранённые изменения": "Unsaved changes",
  "Ширина проводника": "Explorer width",
  "Рабочая область": "Workspace",
  "Открытые вкладки": "Open tabs",
  "Новая вкладка": "New tab",
  "Показать или скрыть инспектор": "Show or hide inspector",
  "История переходов": "Navigation history",
  "Назад": "Back",
  "Вперёд": "Forward",
  "Текущее представление": "Current view",
  "Экспорт сценария": "Export story",
  "Ещё действия": "More actions",
  "Фильтр по главе": "Filter by chapter",
  "Фильтр узлов": "Filter nodes",
  "Найти узел…": "Find node…",
  "Добавить узел": "Add node",
  "Разложить узлы": "Arrange nodes",
  "Разложить узлы (Ctrl+G)": "Arrange nodes (Ctrl+G)",
  "Открыть текст сцены": "Open scene text",
  "Масштаб схемы": "Graph zoom",
  "Увеличить масштаб": "Zoom in",
  "Вписать схему": "Fit graph",
  "Уменьшить масштаб": "Zoom out",
  "Закрыть": "Close",
  "Ширина инспектора": "Inspector width",
  "Свойства и инструменты": "Properties and tools",
  "Инструменты сцены": "Scene tools",
  "Инспектор": "Inspector",
  "Озвучка": "Voice",
  "AI-ассистент": "AI assistant",
  "Скрыть панель": "Hide panel",
  "Состояние проекта": "Project status",
  "Проверить проект (F5)": "Validate project (F5)",
  "Персонажи": "Characters",
  "Локации": "Locations",
  "Переменные": "Variables",
  "Статистика": "Statistics",
  "Новый проект": "New project",
  "Открыть…": "Open…",
  "Сохранить": "Save",
  "Сохранить как…": "Save as…",
  "Недавние": "Recent",
  "Схема": "Canvas",
  "Скопировать сценарий в буфер": "Copy story to clipboard",
  "Отменить": "Undo",
  "Повторить": "Redo",
  "Поиск в проекте": "Project search",
  "Проверить проект": "Validate project",
  "Восстановить": "Restore",
  "Скрыть": "Hide",
  "Заметки": "Notes",
  "Узел": "Node",
  "В проекте пока нет узлов.": "This project has no nodes yet.",
  "Создать первый узел": "Create first node",
  "Проверка проекта": "Validate project",
  "Все": "All",
  "Ошибки": "Errors",
  "Предупр.": "Warnings.",
  "Подсказки": "Hints",
  "проблем": "issues"
};

// Bind only the original shell. Later story text, file paths and editor values always belong to the author.
export function bindShellLanguage(root) {
  const bindings = [];
  function bind(read, write) {
    const initial = read();
    if (!initial) return;
    const key = initial.trim();
    if (!Object.hasOwn(shellStrings, key)) return;
    let last = initial;
    bindings.push(() => {
      if (read() !== last) return;
      last = initial.replace(key, () => t(key, shellStrings[key]));
      write(last);
    });
  }
  const iter = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let item; (item = iter.nextNode());) {
    const text = item;
    bind(() => text.data, value => { text.data = value; });
  }
  for (const el of root.querySelectorAll('[title],[aria-label],[placeholder],[alt]')) {
    for (const name of ['title','aria-label','placeholder','alt']) {
      bind(() => el.getAttribute(name), value => el.setAttribute(name, value));
    }
  }
  return () => { for (const render of bindings) render(); };
}
