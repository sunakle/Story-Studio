// UI copy is translated at its declaration. Values supplied by a document stay verbatim.
let language: "ru" | "en" = "ru";
const listeners = new Set<() => void>();
export function setLanguage(next: "ru" | "en") {
  if (next === language) return;
  language = next;
  listeners.forEach((listener) => listener());
}
export const getLanguage = () => language;
export function subscribeLanguage(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function ui(ru: string, en: string) {
  return language === "en" ? en : ru;
}
