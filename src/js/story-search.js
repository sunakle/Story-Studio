import { t, getLanguage } from './i18n.js';
import { TYPE_LABELS, projectDesigns } from './model.js';

// Saved filters remain valid when the interface language changes.
const typeAliases = {
  line: 'реплика', choice: 'выбор', condition: 'условие', jump: 'переход',
  scene: 'сцена', end: 'конец', note: 'заметка',
};
const fields = new Set(['type', 'chapter', 'speaker', 'tag', 'location']);
const lower = (value) => String(value ?? '').toLocaleLowerCase(getLanguage());
const names = (rows) => new Map((rows || []).map((row) => [row.id, row.name || '']));

/** Build once for a query and model revision; apply to any number of nodes. */
export function compileNodeQuery(project, query = '', { regex = false } = {}) {
  const filters = [];
  const lookup = {
    chapter: names(project.chapters),
    speaker: names(project.characters),
    location: names(project.locations),
  };
  // Keep the unqualified remainder intact, especially in regex mode.
  const text = String(query)
    .replace(/(?:^|\s)([a-z]+):(?:"([^"]*)"|([^\s"]+))/gi, (match, key, quoted, single) => {
      key = lower(key);
      if (!fields.has(key)) return match;
      filters.push([key, lower(quoted ?? single)]);
      return ' ';
    })
    .trim();
  let re;
  if (regex && text) {
    try {
      re = new RegExp(text, 'i');
    } catch (err) {
      return {
        text,
        hasFilters: !!filters.length,
        error: err.message,
        matches: () => false,
        testText: () => false,
      };
    }
  }
  const needle = lower(text);
  const testText = (value) => (re ? re.test(value) : lower(value).includes(needle));
  function matches(n) {
    const values = {
      type: [n.type, typeAliases[n.type], n.type === 'end' ? 'ending' : n.type],
      chapter: [n.chapterId, lookup.chapter.get(n.chapterId)],
      speaker: [n.speakerId, lookup.speaker.get(n.speakerId)],
      tag: n.tags || [],
      location: [n.locationId, lookup.location.get(n.locationId)],
    };
    if (!filters.every(([key, value]) => values[key].some((v) => v && lower(v) === value))) return false;
    if (!text) return true;
    const hay = [
      n.id,
      n.title,
      n.text,
      n.notes,
      n.emotion,
      ...Object.values(values).flat(),
      ...(n.choices || []).map((c) => [c.text, c.hint, c.condition].join(' ')),
      ...(n.branches || []).map((b) => b.condition),
    ]
      .filter(Boolean)
      .join('\n');
    return testText(hay);
  }
  return { text, hasFilters: !!filters.length, error: '', matches, testText };
}

export const entityLists = {
  node: 'nodes',
  chapter: 'chapters',
  character: 'characters',
  location: 'locations',
  variable: 'variables',
};
export const kindLabels = {
  get node() { return t('Узел', 'Node'); },
  get chapter() { return t('Глава', 'Chapter'); },
  get character() { return t('Персонаж', 'Character'); },
  get location() { return t('Локация', 'Location'); },
  get variable() { return t('Переменная', 'Variable'); },
};
export const nodeTitle = (node) =>
  node?.title || node?.text?.replace(/\s+/g, ' ').slice(0, 70) || node?.id || kindLabels.node;

export function jumpCandidates(project) {
  const chapters = names(project.chapters),
    speakers = names(project.characters),
    locations = names(project.locations);
  const rows = [];
  for (const [kind, list] of Object.entries(entityLists)) {
    for (const obj of project[list] || []) {
      const isNode = kind === 'node';
      const title = isNode ? nodeTitle(obj) : obj.name || obj.id;
      const chapter = isNode && chapters.get(obj.chapterId);
      const location = isNode && locations.get(obj.locationId);
      const context = isNode
        ? [TYPE_LABELS[obj.type], chapter, speakers.get(obj.speakerId), location !== chapter && location]
            .filter(Boolean).join(' · ')
        : kindLabels[kind];
      const hay = [title, obj.id, obj.text, obj.name, context, ...(obj.tags || [])]
        .filter(Boolean)
        .join('\n');
      rows.push({ kind, id: obj.id, title, context, hay: lower(hay), name: lower(title) });
    }
  }
  const designs = projectDesigns(project);
  for (const design of designs) {
    const title = design === designs[0] ? 'Gigma Studio' : design.name;
    const context = design.name === title ? t('Дизайн проекта', 'Project design') : design.name;
    rows.push({kind:'gigma', id:design.id, title, context,
      name:lower(title), hay:lower([title, design.name, design.id, context, 'Gigma Studio'].join('\n'))});
  }
  return rows;
}
export function rankCandidates(candidates, query, recents = []) {
  const q = lower(query.trim());
  const rank = new Map(recents.map((r, i) => [r.kind + '/' + r.id, i]));
  const score = (r) => (q && (r.name === q || lower(r.id) === q) ? 0 : q && r.name.startsWith(q) ? 1 : 2);
  return candidates
    .filter((r) => !q || r.hay.includes(q))
    .sort(
      (a, b) =>
        score(a) - score(b) ||
        (rank.get(a.kind + '/' + a.id) ?? Infinity) - (rank.get(b.kind + '/' + b.id) ?? Infinity) ||
        a.title.localeCompare(b.title, getLanguage()),
    )
    .slice(0, 60);
}
