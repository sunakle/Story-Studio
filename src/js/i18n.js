// Language is application state, shared by the renderer's views and pure model helpers.
let language = 'ru';
const listeners = new Set();
export function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const getLanguage = () => language;
export const t = (russian, english) => language === 'en' ? english : russian;

export function setLanguage(value) {
  const next = value === 'en' ? 'en' : 'ru';
  const changed = language !== next;
  language = next;
  if (typeof document !== 'undefined') document.documentElement.lang = language;
  if (changed) for (const notify of listeners) notify();
}

