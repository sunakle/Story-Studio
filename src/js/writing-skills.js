import { t } from './i18n.js';

// Packaged adaptations of the pinned MIT sources. All guidance and links are
// static app assets; no downloaded instructions or executable tools are loaded.
const upstream = 'https://github.com/jwynia/agent-skills/blob/e02ec7e226a6e4f8419fd3b88a1d8e472d421b32/skills/creative/fiction/';
const skills = [
  {
    path: 'character/dialogue',
    title: ['Речь и подтекст', 'Dialogue and subtext'],
    description: ['Манера речи персонажей и скрытые намерения в диалоге.', 'Character speech patterns and the intentions behind a line.'],
    guidance: [
      'При написании или разборе диалога прочитай соседние реплики и карточки персонажей. Найди, что каждый собеседник хочет получить и о чём избегает говорить. Покажи различие в длине фраз, лексике или том, какой вопрос остаётся без ответа. При переносе готовых реплик автора в ноды сохраняй их дословно, если он отдельно не попросил переработку.',
      'For a dialogue-writing or review request, consult adjacent lines and the speakers’ profiles. Identify what each speaker wants and what they avoid saying. Distinguish them through phrasing, vocabulary or a question they leave unanswered. Preserve the author’s exact lines when mapping existing prose into nodes unless a rewrite was requested.',
    ],
  },
  {
    path: 'structure/scene-sequencing',
    title: ['Последовательность сцен', 'Scene sequencing'],
    description: ['Цели героев, последствия действий и переходы между сценами.', 'Character goals, consequences and transitions between scenes.'],
    guidance: [
      'При работе со сценами проследи, чего добивается герой, что ему мешает и как результат меняет следующий шаг. В каждой описанной развилке соедини вариант с его последствием, а точки повторного схождения — с общей сценой. При проверке темпа отметь конкретный переход, где реакции героя не хватает или она затягивается. Соблюдай порядок событий и ветки автора.',
      'For scene structure, trace a character’s objective, the obstacle and how the outcome shapes the next action. Link each authored choice to its consequence and reconnect converging branches to their shared scene. When pacing needs attention, point to the transition where a reaction is missing or overstays. Follow the author’s sequence and branch design.',
    ],
  },
  {
    path: 'craft/revision',
    title: ['Редактура сценария', 'Story revision'],
    description: ['Проверка структуры, формулировок и непротиворечивости деталей.', 'Reviewing structure, line phrasing and continuity.'],
    guidance: [
      'Для редактуры выбери масштаб из запроса автора. При общем пересмотре проверь мотивацию и причинность по сценам, затем отредактируй конкретные реплики, в конце сверь имена, локации и факты на связанных ветках. При локальной правке затрагивай только указанный фрагмент. Для замечаний указывай сцену или узел и конкретный эффект предлагаемой правки.',
      'Match a revision pass to the author’s requested scope. For a broad revision, trace motivation and cause across scenes, refine individual lines, then check names, places and facts on connected branches. Keep a local edit within the specified passage. For review feedback, identify the scene or node and the effect of the proposed change.',
    ],
  },
];

export function writingSkillPrompt() {
  return [
    t('Навыки сценарной работы. Применяй подходящий приём к задаче автора.', 'Writing skills. Use the relevant technique for the author’s task.'),
    ...skills.map(skill => t(...skill.title) + '. ' + t(...skill.guidance)),
  ].join('\n');
}

export function writingSkillsSettingsHTML() {
  const items = skills.map(skill => {
    const url = upstream + skill.path + '/SKILL.md';
    return `<li><strong>${t(...skill.title)}</strong><p>${t(...skill.description)}</p>
      <a href="${url}" data-writing-source>${t('Источник', 'Source')} · ${skill.path.split('/').at(-1)}</a></li>`;
  }).join('');
  return `<details class="ai-writing-skills"><summary>${t('Встроенные навыки сценариста', 'Built-in writing skills')}</summary>
    <p class="hint-text">${t('Адаптированы для StoryForge из коллекции jwynia/agent-skills. Лицензия MIT.', 'Adapted for StoryForge from jwynia/agent-skills. MIT license.')}</p>
    <ul>${items}</ul></details>`;
}

export function wireWritingSkillSources(container) {
  container.querySelectorAll('a[data-writing-source]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    window.sf.app.openExternal(link.href);
  }));
}
