/**
 * StoryForge — один набор линейных иконок.
 * Все иконки: viewBox 24×24, stroke 1.8, currentColor. Размер задаётся вызовом.
 * Глифы (✓ ✕ ⚙ ⚠ ↑ ↓ →) в интерфейсе не используются — только отсюда.
 */

const PATHS = {
  file: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5V8h4M9 12h6M9 15h5"/>',
  folder: '<path d="M3.5 6.5h6l2 2H20v10.2a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M4 9.5h16M4 14.5h16M10 10v9"/>',
  graph: '<circle cx="12" cy="5.5" r="2.5"/><circle cx="5.5" cy="17.5" r="2.5"/><circle cx="18.5" cy="17.5" r="2.5"/><path d="m10.8 7.8-4.1 7.4m6.5-7.4 4.1 7.4M8 17.5h8"/>',
  bookmark: '<path d="M6.5 4.5h11v15l-5.5-3.7-5.5 3.7z"/>',
  link: '<path d="m10 13.5 4-4m-2.2 5.8-2 2a3.8 3.8 0 1 1-5.4-5.4l3.4-3.4a3.8 3.8 0 0 1 5.3 0m-.9-.1 2-2a3.8 3.8 0 0 1 5.4 5.4l-3.4 3.4a3.8 3.8 0 0 1-5.3 0"/>',
  play: '<path d="M7 4.5 19 12 7 19.5z"/>',
  volume: '<path d="M4 9h4l5-4v14l-5-4H4zM16 8a6 6 0 0 1 0 8m2.5-10.5a9 9 0 0 1 0 13"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  pin: '<path d="m8 3 8 1-1 6 3 3v1H6v-1l3-3zM12 14v7"/>',
  filter: '<path d="M3.5 5.5h17l-6.7 7.3v5l-3.6 1.8v-6.8z"/>',
  columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
  sort: '<path d="M7 4v16m-3.5-4L7 20l3.5-4M13 6h7m-7 5h5m-5 5h3"/>',
  group: '<path d="M3.5 5.5h17M9 12h11m-11 6h11M4 9v9h2"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  external: '<path d="M13 4h7v7m0-7-9 9M10 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4"/>',
  edit: '<path d="m15.5 4.5 4 4M4.5 19.5l4.5-1 11-11a1.8 1.8 0 0 0 0-2.5l-1-1a1.8 1.8 0 0 0-2.5 0l-11 11z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  branch: '<circle cx="7" cy="5" r="2"/><circle cx="7" cy="19" r="2"/><circle cx="17" cy="7" r="2"/><path d="M7 7v10m0-2c0-4 10-1 10-6"/>',
  type: '<path d="M4 7V4.5h16V7M12 5v14m-4 0h8"/>',
  hash: '<path d="M10 4 7.5 20M16.5 4 14 20M4.5 9.5h16M3.5 14.5h16"/>',
  check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 4.6 3.2 19.4h17.6L12 4.6z"/><path d="M12 10v4.2"/><path d="M12 17.2v.1"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.9v.1"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.5-2.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4 1.7 1.7 0 0 0-1.6 0z"/>',
  up: '<path d="M12 19.5V5"/><path d="M6 11l6-6 6 6"/>',
  down: '<path d="M12 4.5V19"/><path d="M6 13l6 6 6-6"/>',
  right: '<path d="M4.5 12h15"/><path d="M13.5 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  layout:
    '<rect x="3.5" y="4.5" width="7" height="6" rx="1.5"/><rect x="13.5" y="4.5" width="7" height="6" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="6" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="6" rx="1.5"/>',
  fit: '<path d="M4.5 9V4.5H9"/><path d="M19.5 9V4.5H15"/><path d="M4.5 15v4.5H9"/><path d="M19.5 15v4.5H15"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m19.5 19.5-3.6-3.6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  trash: '<path d="M5 7h14"/><path d="M9.5 7V5h5v2"/><path d="M6.5 7l.8 12h9.4l.8-12"/>',
  copy: '<rect x="9" y="9" width="10" height="10" rx="2"/><path d="M15 6.5H7a2 2 0 0 0-2 2v8"/>',
  target: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2"/>',
  wand: '<path d="m4 20 12-12 2 2L6 22zM13 11l2 2M5 4v4M3 6h4M17 2v4M15 4h4M20 14v4M18 16h4"/>',
  spark: '<path d="M12 4.5v4M12 15.5v4M4.5 12h4M15.5 12h4"/><path d="M7.8 7.8l2.2 2.2M14 14l2.2 2.2M16.2 7.8 14 10M10 14l-2.2 2.2"/>',
};

/** Возвращает инлайн-SVG иконки. name — ключ из PATHS, size — сторона в px. */
export function icon(name, size = 16) {
  const body = PATHS[name] || '';
  return `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export const ICON_NAMES = Object.keys(PATHS);
