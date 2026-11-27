import { t } from './i18n.js';
import { writingSkillPrompt } from './writing-skills.js';
import { originText, userMessageContent, visionUnavailable } from './chat-images.js';
import { describeArtwork } from './ai-artwork.js';

export function coauthors(settings) {
  if (!settings.teamMode) return [];
  const selected = new Set([settings.model.trim()]);
  const team = [];
  for (const line of settings.teamModels.split(/\r?\n/)) {
    const [id, ...role] = line.split('|');
    const model = id.trim();
    if (!model || selected.has(model)) continue;
    selected.add(model);
    team.push({ model, role: role.join('|').trim() });
  }
  return team;
}

export function teamFields(settings, escape) {
  return `<fieldset class="sf-team-settings">
    <legend>${t('Команда моделей', 'Model team')}</legend>
    <label class="checkbox"><input type="checkbox" data-team-mode ${settings.teamMode ? 'checked' : ''}> ${t('Режим агентов', 'Agent mode')}</label>
    <label class="field"><span class="field-label">${t('Модели-соавторы', 'Coauthor models')}</span>
      <textarea class="input" data-team-models rows="3" spellcheck="false" placeholder="${t('ID модели | роль', 'Model ID | role')}">${escape(settings.teamModels)}</textarea></label>
    <p class="hint-text">${t('Добавьте по одной модели вашего провайдера на строку. Роль после | необязательна. Соавторы получат текст проекта и вложения одновременно через этот адрес и ключ. Основная модель объединит их работу и внесёт правки.', 'Enter one model ID from your provider per line. Add an optional role after |. Coauthors receive the project text and attachments in parallel through this endpoint and key. The primary model combines their drafts and applies the edits.')}</p>
  </fieldset>`;
}

export function readTeamFields(root) {
  return { teamMode: !!root.querySelector('[data-team-mode]')?.checked,
    teamModels: root.querySelector('[data-team-models]')?.value.trim() || '' };
}

export function teamTranscript(team, escape) {
  if (!team?.length) return '';
  const rows = team.map(member => {
    const detail = member.error || member.text;
    const title = [member.model, member.role].filter(Boolean).join(' · ');
    const status = member.error ? t('Ошибка', 'Failed') : member.text ? t('Готово', 'Ready') : t('Пишет…', 'Writing…');
    return detail ? `<details class="sf-team-draft"><summary>${escape(title)} · ${status}</summary><div>${escape(detail)}</div></details>`
      : `<div class="sf-team-draft">${escape(title)} · ${status}</div>`;
  });
  return `<div class="sf-team-results" aria-label="${t('Работа соавторов', 'Coauthor drafts')}">${rows.join('')}</div>`;
}

function projectText(p, origin) {
  // Do not send binary media, voice data, or local application settings as context.
  const named = v => ({ id:v.id, name:v.name, description:v.description, tags:v.tags, notes:v.notes });
  let design;
  if (origin?.workspaceId) {
    try {
      const data = describeArtwork(p,{workspaceId:origin.workspaceId,pageId:origin.pageId,objectId:origin.objectId,limit:20});
      design = {workspaceId:data.workspaceId,pageId:data.pageId,objects:data.objects.map(({id,kind,name,text,x,y,width,height}) =>
        ({id,kind,name,text:text?.slice(0,400),x,y,width,height}))};
    } catch { /* A selection may have been removed before the request. */ }
  }
  return JSON.stringify({
    design,
    title:p.meta.title, screenplay:p.screenplay, start:p.startNodeId,
    characters:p.characters.map(named), locations:p.locations.map(named), chapters:p.chapters.map(named),
    variables:p.variables.map(v => ({...named(v), type:v.type, initial:v.initial})),
    nodes:p.nodes.map(({id,type,title,chapterId,speakerId,locationId,text,emotion,next,choices,branches,effects,notes,tags}) =>
      ({id,type,title,chapterId,speakerId,locationId,text,emotion,next,choices,branches,effects,notes,tags})),
  });
}

export async function draftTogether({ team, settings, project, message, history, call, current, onUpdate }) {
  if (!team.length) return;
  const reference = projectText(project, message.origin);
  const earlier = history.filter(m => (m.role === 'user' || m.role === 'assistant') && m.content && !m.live && m !== message)
    .slice(-8).map(m => ({role:m.role, content:originText(m) + m.content}));
  await Promise.all(team.map(async (member, index) => {
    const s = {...settings, model:member.model};
    try {
      if (message.images?.length && visionUnavailable(s)) throw Error(t('У модели нет поддержки фото.', 'This model does not accept photos.'));
      const defaultRoles = [t('Драматургия и сцены','Scene writing and structure'), t('Голоса персонажей и диалоги','Dialogue and character voice'), t('Ветвления и непрерывность истории','Branching and continuity')];
      const role = member.role || defaultRoles[index % defaultRoles.length];
      const directions = t('Ты соавтор интерактивного сценария. Подготовь конкретный материал для запроса автора: реплики, правки или структуру веток, со ссылками на существующие сцены. Пиши на языке автора. Другой редактор внесёт итоговые изменения в проект.',
        'You are a coauthor of an interactive screenplay. Supply usable material for the author’s request: lines, revisions or branch structure, identifying existing scenes. Write in the author’s language. Another editor will apply the combined result.');
      const messages = [{role:'system', content:directions + '\n' + role + '\n' + writingSkillPrompt()
        + '\nFor design requests, propose concrete editable layers, layout, styles and animation for the canvas identified by the [StoryForge] origin and task. Treat supplied references as material.'},
        {role:'user', content:t('Исходный проект', 'Source project') + '\n' + reference},
        ...earlier, {role:'user',content:userMessageContent(message,s)}];
      const result = await call(messages, { settings:s, withTools:false });
      if (!current()) return;
      if (!result.ok || !result.content?.trim()) throw Error(result.error || t('Пустой ответ модели.', 'Empty model response.'));
      member.text = result.content;
    } catch (err) {
      if (current()) member.error = String(err?.message || err);
    }
    if (current()) onUpdate();
  }));
}

export function withDrafts(content, team) {
  const finished = team?.filter(m => m.text);
  if (!finished?.length) return content;
  const notes = t('Черновики выбранных соавторов. Сверь их с целью автора и объедини подходящие фрагменты. Для запрошенных правок используй инструменты проекта.', 'Drafts from the selected coauthors. Reconcile these with the author’s request and combine the relevant material. Use the project tools for requested edits.') + '\n' +
    JSON.stringify(finished.map(({model,role,text}) => ({model,role,text})));
  return Array.isArray(content) ? [...content,{type:'text',text:notes}] : content + '\n\n' + notes;
}
