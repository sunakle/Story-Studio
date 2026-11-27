# StoryForge — контракт модулей (обязателен к соблюдению)

Единый источник правды для всех, кто пишет код приложения. Спецификация продукта — в
`../PROMPT-StoryForge.md` (разделы 1–13). Здесь только технические договорённости между модулями.

## 0. Жёсткие правила

- Electron, **без сборщиков**: никаких webpack/vite/React/TypeScript. Только `main.js`, `preload.js` (CommonJS) и рендерер на чистых ES-модулях (`<script type="module">`).
- Никаких CDN, внешних шрифтов, npm-библиотек в рендерере. Иконки — инлайн SVG 16×16, `stroke="currentColor"`.
- Рендерер не имеет доступа к `fs`, `child_process`, `fetch` к AI API. Только `window.sf.*` (см. §4).
- Все строки интерфейса — на русском. Комментарии — на русском в неочевидных местах.
- Никаких `TODO`, «заглушек», `alert()`, `console.log` в рабочем коде. Для отладки: `const devLog = (...a) => { if (window.__SF_DEV__) console.log(...a); };` в начале модуля.
- Кодировка файлов — UTF-8 без BOM. Кириллица в коде и данных допустима и обязательна.
- Файлы, не входящие в твой список — **не трогать**. `src/js/app.js`, `main.js`, `preload.js`, `src/index.html`, `src/styles.css` (кроме хвоста после маркера) пишет только лид.
- CSS: переиспользуй классы из `src/styles.css`. Если чего-то не хватает — дописывай **только после строки** `/* ===== дополнения модулей ===== */` в конце `src/styles.css`, с префиксом своего модуля (`.graph-…`, `.insp-…`, `.panel-…`, `.ai-…`).

## 1. Файловая структура

```
storyforge/
  package.json            (готов)
  main.js                 (готов)  — окно, меню, IPC, AI-прокси, файлы, экспорт
  preload.js              (готов)  — contextBridge -> window.sf
  src/index.html          (готов)  — статический каркас, все id на месте
  src/styles.css          (готов)  — дизайн-система
  src/package.json        (готов)  — {"type":"module"} только для node --check
  src/js/model.js         -> модель, операции, undo/redo, валидация, статистика
  src/js/export.js        -> Godot (dialogue.json + dialogue_runner.gd + README), Ren'Py, Markdown, JSON
  src/js/graph.js         -> SVG-граф: пан/зум/drag/рёбра/контекстное меню/автораскладка
  src/js/inspector.js     -> правая панель «Инспектор» + карточки персонажа/локации/переменной
  src/js/panels.js        -> левая панель (6 вкладок) + оверлей валидации
  src/js/ai.js            -> AI-ассистент: настройки, стриминг, tool-calling, инструменты
  src/js/app.js           (лид)    — bootstrap, тулбар, хоткеи, автосохранение, статусбар, ui-хелперы
```

## 2. Модель данных (`*.sfproj`, JSON)

```json
{
  "schemaVersion": 1,
  "meta": { "title": "", "author": "", "description": "", "createdAt": "ISO", "updatedAt": "ISO" },
  "screenplay": "",
  "gigmaWorkspaces": [],
  "startNodeId": "n_start",
  "characters": [{ "id": "c_x", "name": "", "color": "#7c9cff", "role": "", "age": "", "description": "", "appearance": "", "personality": "", "speech": "", "notes": "", "tags": [] }],
  "locations": [{ "id": "l_x", "name": "", "description": "", "atmosphere": "", "timeOfDay": "", "notes": "", "tags": [] }],
  "variables": [{ "id": "v_x", "name": "trust_mark", "type": "number|bool|string", "initial": 0, "description": "" }],
  "chapters": [{ "id": "ch_x", "name": "", "color": "#7c9cff", "collapsed": false }],
  "nodes": [{ "id": "n_x", "type": "line|choice|condition|jump|scene|end|note", "chapterId": "", "title": "", "speakerId": "", "locationId": "", "text": "", "emotion": "", "next": "", "choices": [], "branches": [], "effects": [], "tags": [], "notes": "", "color": "", "position": { "x": 0, "y": 0 } }]
}
```

- `choices[]`: `{ "id": "o_x", "text": "", "next": "", "condition": "", "effects": [], "hint": "" }`
- `branches[]`: `{ "id": "b_x", "condition": "", "next": "" }`
- `effects[]`: `{ "varId": "v_x", "op": "set|+=|-=|toggle", "value": 0 }`
- Поле `gigmaWorkspaces` хранит графику внутри `.sfproj`. Первый элемент содержит основной холст проекта. Дополнительные элементы из прежних версий сохраняют свои ID, имена и документы. У каждого элемента есть `id`, `name` и полный JSON-документ Gigma в `document`. Значение `null` обозначает пустой холст. Если поле отсутствует или массив пуст, редактор показывает чистый холст и записывает его при первой правке.
- Связи живут только в `next` / `choices[].next` / `branches[].next`. Битые ссылки **не** чинятся автоматически — их ловит валидатор.
- Поля, которых нет в схеме, не выдумывать. Недостающие поля при загрузке заполнять дефолтами (`migrateProject`).

## 3. `model.js` — публичный API (экспорт модуля)

```js
export const NODE_TYPES = ['line', 'choice', 'condition', 'jump', 'scene', 'end', 'note'];
export const TYPE_LABELS = { line: 'Реплика', choice: 'Выбор', condition: 'Условие', jump: 'Переход', scene: 'Сцена', end: 'Конец', note: 'Заметка' };
export const OP_LABELS   = { set: '=', '+=': '+=', '-=': '-=', toggle: 'переключить' };

export function uid(prefix)                      // 'n_' + 6 символов [a-z0-9]
export function createEmptyProject(overrides)    // валидный пустой проект
export function migrateProject(raw)              // -> { project, warnings: string[] } — заполняет дефолты, чинит типы
export function plural(n, forms)                 // forms = ['узел','узла','узлов'] -> 'узла' (ТОЛЬКО форма; число подставляет вызывающий: `${n} ${plural(n, forms)}`)
export function countWords(text)                 // слова в русском тексте
export function validateProject(project)         // -> Issue[] (см. §3.2)
export function computeStats(project)            // -> объект статистики (см. §3.3)
export function autoLayout(project)              // -> { positions: { [id]: {x, y} } } — чистая, не мутирует
export function outgoingEdges(project, nodeId)   // -> [{ to, kind, choiceId?, branchIndex?, label? }]
export function incomingEdges(project, nodeId)   // -> [{ from, kind, choiceId?, branchIndex? }]
export function parseCondition(expr)             // -> { ok, error, names: string[] }
export function findPath(project, from, to)      // -> [ids] | null
export function getSubtree(project, id, depth)   // -> { nodes: [...], edges: [...] }
export function nodeSpeakerName(project, node)   // -> строка ('' если нет)
export function nodeLocationName(project, node)
export function applyOps(project, ops)           // -> { ok, error?, changed: string[], created: string[] }
export class Store { ... }
export const store = new Store();
```

`kind` у ребра: `'next' | 'choice' | 'branch' | 'else'`. Для `choice`-ребра `choiceId`, для `branch` — `branchIndex`, `label` — текст варианта (для подписи на ребре).

**Временные id (`tmp_1`, `tmp_2`)** резолвятся НЕ в модели, а в слое инструментов `ai.js`: перед вызовом `applyOps` он заменяет `tmp_N` на реальные id, сгенерированные через `uid()`, и переписывает все ссылки внутри того же батча. `model.js` про `tmp_` ничего не знает. `applyOps().created` — упорядоченный массив реальных id в порядке операций (нужен UI, чтобы выделить только что созданный узел).

### 3.1 Операции `applyOps` (единственный путь мутации проекта)

Все операции атомарны: при ошибке проект остаётся нетронутым (работать на клоне, при ошибке не применять).

| op | аргументы | смысл |
|---|---|---|
| `updateNode` | `id, patch` | частичное обновление узла; `patch.id` игнорируется |
| `createNode` | `node` | создать узел; без `id` — сгенерировать; `position` по умолчанию рядом с центром |
| `deleteNode` | `id, reconnectTo?` | удалить; входящие связи по умолчанию перенаправить на `next` узла или `reconnectTo` |
| `connect` | `from, to, choiceText?, condition?, branchIndex?` | для line/scene/jump — `next`; для choice — добавить вариант (если `choiceText`) или заменить `next`; для condition — добавить ветвь или «иначе» (`branchIndex:'else'`) |
| `disconnect` | `from, choiceId?` | убрать связь (вариант или `next`) |
| `setPositions` | `positions` | `{id:{x,y}}` |
| `setNodeTexts` | `items:[{id,text}]` | массовая правка текста |
| `setChoices` / `setBranches` / `setEffects` | `id, choices/branches/effects` | заменить массив целиком |
| `createCharacter` / `updateCharacter` / `deleteCharacter` | `character` / `id, patch` / `id, reassignTo?` | база персонажей |
| `createLocation` / `updateLocation` / `deleteLocation` | аналогично | локации |
| `createVariable` / `updateVariable` / `deleteVariable` | `variable` / `id, patch` / `id` | переменные |
| `createChapter` / `updateChapter` / `deleteChapter` | `chapter` / `id, patch` / `id, moveNodesTo?` | главы |
| `setStart` | `id` | стартовый узел |
| `setMeta` | `patch` | meta проекта |
| `createGigmaWorkspace` | `id?`, `name?`, `document?` | Создать пространство и вернуть его ID в `created` |
| `updateGigmaWorkspace` | `id`, `name?`, `document?` | Переименовать пространство или сохранить макет |
| `deleteGigmaWorkspace` | `id` | Удалить пространство из проекта с возможностью отмены |

### 3.2 Валидация — ровно 13 классов (код → серьёзность)

`Issue = { severity: 'error'|'warning'|'hint', code: string, message: string, nodeId?: string, entity?: {kind,id}, field?: string }`

1. `start-missing` (error) — `startNodeId` не найден.
2. `broken-link` (error) — `next` / `choices[].next` / `branches[].next` ведёт в несуществующий узел.
3. `empty-text` (warning) — `line`/`scene` без текста; `choice-empty` (error) — `choice` без вариантов.
4. `unreachable` (warning) — узел недостижим из старта (кроме `note`).
5. `dead-end` (error) — у `line`/`scene`/`condition`/`choice` нет `next` и нет исходящих ветвей/вариантов.
6. `empty-choice` (warning) — пустой текст варианта; `duplicate-choice` (warning) — два варианта с одинаковым текстом.
7. `no-speaker` (warning) — спикер не выбран/удалён; `no-location` (hint) — локация не выбрана.
8. `unused-character` / `unused-location` / `unused-variable` (hint) — не используется.
9. `bad-effect` (error) — эффект ссылается на несуществующую переменную или неизвестную операцию.
10. `bad-condition` (error) — синтаксическая ошибка в условии.
11. `duplicate-variable` (error) — одинаковые имена переменных.
12. `cycle-no-exit` (warning) — `condition`/`choice` замкнут сам на себя и нет пути к `end`.
13. `no-chapter` (hint) — узел без главы.

На корректных тестовых данных — **ноль ошибок** и ноль ложных предупреждений (подсказки допустимы, но лучше тоже ноль).

### 3.3 Статистика `computeStats(project)`

```js
{
  nodes, lines, words, chars, choices, endings, notes,
  minutes,                 // words/150 + 3 сек на каждый выбор, округлить вверх
  byType: { line: n, ... },
  bySpeaker: [{ id, name, color, lines, words }],   // сортировка по words desc
  byLocation: [{ id, name, scenes, words }],
  longestChain,            // глубина от старта в узлах
  unreachable: n,
  chapters: [{ id, name, nodes, words }]
}
```

### 3.4 `Store` — состояние + undo/redo

```js
store.project          // текущий проект (мутируется только через apply)
store.filePath         // string | null
store.dirty            // bool
store.selection        // { kind: 'node'|'character'|'location'|'variable'|'chapter'|null, id: string|null }
store.settings         // заполняется app.js, читать можно

store.apply(ops, { label, group } = {})  // -> { ok, error?, created }
   // group: строка-ключ — правки с одинаковым group в пределах 800 мс склеиваются в одну запись undo
store.beginGroup(label) / store.endGroup()   // явная транзакция (drag, серия правок ИИ)
store.undo() / store.redo() / store.canUndo() / store.canRedo()
store.clearHistory()
store.setProject(project, { filePath, dirty } = {})
store.setSelection({ kind, id })          // уведомляет подписчиков
store.subscribe(fn)                       // -> unsubscribe; fn({ type: 'change'|'selection'|'project', label? })
store.markSaved(filePath)                 // dirty=false
store.snapshot()                          // глубокая копия проекта
store.restoreSnapshot(snap, label)        // восстановить как одну undo-запись
store.newId(prefix)                       // уникальный id
```

- Лимит истории — 100 записей. Снимки — `structuredClone` проекта.
- После `undo`/`redo` `store` рассылает `{type:'project'}`.

## 4. `window.sf` — мост в main (уже реализован в preload.js)

```js
sf.file.openDialog() -> {ok, path, content, project} | {ok:false, canceled}
sf.file.openPath(p) -> {ok, path, content, project} | {ok:false, error}
sf.file.save(path, content) -> {ok, path} | {ok:false, error}
sf.file.saveLocal({key, title, content}) -> {ok, path} | {ok:false, error}
sf.file.openLocalFolder() -> {ok} | {ok:false, error}
sf.file.saveAs(suggestedName, content) -> {ok, path} | {ok:false, canceled}
sf.file.recent() -> string[];  sf.file.recentAdd(p);  sf.file.recentClear()
sf.settings.get() -> settings;  sf.settings.set(patch) -> settings
sf.autosave.write(content) -> {ok, at};  sf.autosave.read() -> {ok, content, mtime};  sf.autosave.clear()
sf.history.read() -> messages[];  sf.history.write(messages)
sf.exportFiles.chooseDir(suggested) -> {ok, dir} | {canceled};  sf.exportFiles.write(dir, [{name, content}]) -> {ok, dir, written}
sf.ai.chat({ requestId, baseUrl, apiKey, extraHeaders, body, timeoutMs }) -> {ok, content, toolCalls:[{id,name,arguments}], finishReason} | {ok:false, error, status?}
sf.ai.abort(requestId);  sf.ai.test({ baseUrl, apiKey, extraHeaders }) -> {ok, models} | {ok:false, error}
sf.ai.onChunk(cb) -> unsubscribe      // cb({ requestId, delta?, done?, error? })
sf.clipboard.write(text);  sf.clipboard.read()
sf.dialog.message({ type, title, message, detail, buttons }) -> { response: index }
sf.app.setDirty(bool);  sf.app.info() -> {version, electron, node, userData, dev};  sf.app.quit()
sf.app.showItem(path);  sf.app.openExternal(url)
sf.onMenu(cb) -> unsubscribe          // cb({ action }) — действия меню main-процесса
```

## 5. DOM-каркас (id уже есть в `src/index.html`)

| id | назначение | кто наполняет |
|---|---|---|
| `projectTitle` | название проекта (input) | app |
| `btnFile`, `menuFile`, `recentList` | меню «Файл» | app |
| `btnExport`, `menuExport` | меню «Экспорт» | app |
| `btnUndo`, `btnRedo`, `btnSearch`, `btnTheme`, `btnValidate`, `badgeIssues` | лента, меню рабочей области и строка состояния | app |
| `btnToggleLeft`, `btnToggleRight`, `btnSettings` | лента, меню рабочей области и строка состояния | app |
| `banner`, `bannerText`, `btnRestore`, `btnDismissBanner` | восстановление автосохранения | app |
| `leftTabs` (`.tab[data-tab]`), `leftBody` | левая панель | **panels.js** |
| `splitterLeft`, `splitterRight` | ресайз панелей | app |
| `graphFilters`: `filterChapter`, `filterText`, `filterNotes`, `btnAddNode`, `btnLayout`, `btnFit`, `zoomLabel` | фильтры графа | app (логика), graph (зум-лейбл) |
| `graphHost`, `graph` (svg), `graphEmpty`, `btnCreateFirst` | граф | **graph.js** |
| `validationPanel`, `validationBody`, `sevFilter`, `btnCloseValidation` | оверлей валидации | **panels.js** |
| `rightTabs` (`.tab[data-tab=inspector|ai]`), `inspectorBody` | инспектор | **inspector.js** |
| `aiBody` | AI-чат | **ai.js** |
| `statusbar`: `stFile`, `stDirty`, `stCounts`, `stAutosave`, `stIssues`, `stVersion` | статусбар | app |
| `modalRoot`, `contextMenu`, `toastRoot` | модалки, контекстное меню, тосты | app (API), graph (контекстное меню) |

## 6. Фабрики модулей (сигнатуры — обязательны)

Все фабрики получают `ctx = { store, ui, root }` и возвращают объект с методами. Модули **не импортируют друг друга**, только `model.js`.

```js
// graph.js
export function createGraph({ host, svg, store, ui }) => {
  render(), refresh(), fit(), centerOn(id), autoLayout(), setFilter({ chapterId, text, notes }), destroy(),
  getSelectedId(), setZoom(z), getZoom()
}

// inspector.js
export function createInspector({ root, store, ui }) => {
  render(), focusNode(id), openEntity(kind, id)   // kind: 'character'|'location'|'variable'|'chapter'
}

// panels.js
export function createPanels({ root, store, ui }) => {
  render(), setTab(name), getTab(), focusSearch(query),
  showValidation(issues), hideValidation(), toggleValidation()
}

// ai.js
export function createAI({ root, store, ui }) => {
  render(), focusInput(), openSettings(), clearHistory(), isConfigured(), sendPreset(text)
}
```

### 6.1 `ui` — хелперы, которые даёт `app.js`

```js
ui.store, ui.settings            // store и текущие настройки (объект, менять через ui.saveSettings)
ui.toast(text, kind)             // kind: 'info'|'good'|'bad'|'warn'
ui.modal({ title, body, buttons, wide })  // body: HTML-строка или DOM-узел; buttons: [{label, kind:'primary'|'danger'|'', onClick(close)}]; -> { close() }
ui.confirm(message, { detail, danger, okLabel, cancelLabel }) -> Promise<boolean>
ui.selectNode(id)                // выбрать узел: selection + центр графа + вкладка «Инспектор»
ui.selectEntity(kind, id)
ui.centerOn(id)
ui.refresh()                     // перерисовать панели + инспектор + граф + статусбар
ui.refreshGraph(); ui.refreshPanels(); ui.refreshInspector(); ui.refreshStatus()
ui.setLeftTab(name); ui.setRightTab('inspector'|'ai')
ui.validate()                    // прогнать валидацию, вернуть Issue[], обновить бейдж/статусбар
ui.exportFormat(format)          // 'godot'|'renpy'|'markdown'|'json'|'clipboard'
ui.saveProject(saveAs)
ui.openSettings()
ui.escapeHTML(str)               // экранирование для innerHTML
ui.plural(n, forms)              // = model.plural
ui.highlight(text, query, { regex, caseSensitive })
ui.el(html)                      // -> DOM-узел из строки
ui.debounce(fn, ms)
ui.chapterOptions()              // -> [{id,name}]
ui.hotkeysHelp()
ui.graph, ui.panels, ui.inspector, ui.ai    // ссылки после инициализации
```

## 7. `export.js` — API

```js
export function buildExport(project, format)  // format: 'godot'|'renpy'|'markdown'|'json'|'clipboard'
// -> { files: [{ name, content }], warnings: string[], kind: 'dir'|'file'|'text' }
export function buildGodotDialogue(project)   // -> объект dialogue.json (§7 спеки)
export function buildGodotRunner()            // -> строка dialogue_runner.gd (Godot 4.x, GDScript)
export function buildGodotReadme(project)     // -> строка README.md
export function buildRenpy(project)           // -> строка .rpy
export function buildMarkdown(project)        // -> строка .md
export function buildJson(project)            // -> строка JSON
```

- Godot — главный формат: 3 файла (`dialogue.json`, `dialogue_runner.gd`, `README.md`).
- Битые ссылки не роняют экспорт: в текстовых форматах `# ОШИБКА: …`, в Godot JSON `"broken": true`, плюс `warnings[]`.
- Кириллица — UTF-8, имена персонажей в `Character("Имя")` (Ren'Py), `speaker` — человекочитаемое имя.

## 8. `ai.js` — требования

- Настройки провайдера в `settings.ai`: `{ preset, baseUrl, apiKey, model, temperature, maxTokens, extraHeaders, allowDelete, showTools, teamMode, teamModels }`. Пресеты: OpenAI / DeepSeek / OpenRouter / Ollama / Custom. Ключ маскируется (`sk-…abcd`), в логи не попадает.
- Цикл: системный промт (дословно из §8.5 спеки) + сводка проекта + история (последние 20) → `POST {base}/chat/completions` через `sf.ai.chat` со `stream:true`, `tools`, `tool_choice:'auto'` → выполнить `tool_calls` последовательно → `role:'tool'` → повторить, максимум **25 шагов**.
- Все правки одного сообщения — **одна транзакция undo**: `store.snapshot()` до, кнопка «Отменить правки ИИ» после (`store.restoreSnapshot`).
- Инструменты (все обязательны): `project_summary`, `list_nodes`, `get_node`, `search_nodes`, `get_character`, `list_characters`, `get_location`, `list_locations`, `list_variables`, `validate`, `statistics`, `get_subtree`, `find_path`, `create_node`, `update_node`, `delete_node`, `duplicate_node`, `connect`, `disconnect`, `set_start_node`, `move_node`, `auto_layout`, `bulk_apply`, `set_node_texts`, `create_character`, `update_character`, `delete_character`, `create_location`, `update_location`, `delete_location`, `create_variable`, `update_variable`, `delete_variable`, `create_chapter`, `update_chapter`, `delete_chapter`, `set_project_meta`, `export_project`, `save_project`.
- `bulk_apply` — атомарно, поддерживает временные id `tmp_1` в `next`/`choices[].next`/`connect.to`, возвращает `{ok, applied, createdIds}`.
- Удаление без подтверждения запрещено, если в настройках не включено `allowDelete` → `ui.confirm`.
- Текст вкладки сохраняется в `project.screenplay`. Для старых файлов значение по умолчанию — пустая строка. Чат читает текст страницами, применяет точечные изменения и строит связи с помощью `get_screenplay`, `edit_screenplay` и `build_story_graph`.
- При включённом `teamMode` соавторы готовят черновики параллельно на выбранном подключении. Основная модель применяет итоговые изменения одной транзакцией. Команда и ключ находятся в настройках приложения.
- Стриминг: чанки через `sf.ai.onChunk` по `requestId`, кнопка «Стоп» → `sf.ai.abort`.
- Без ключа — приглашение «Настроить AI» вместо чата.

## 9. Проверка синтаксиса (для всех)

```powershell
node --check src\js\model.js      # package.json в src/ помечает файлы как ESM
```

Дополнительно лид прогоняет: запуск Electron, `node --check` для всех файлов, тест `export.js` на тестовой истории (генерация файлов в temp), проверку валидации корректной истории (0 ошибок) и на «сломанных» копиях.

---

## 11. Уточнения после аудита (обязательны к соблюдению)

1. **`plural(n, forms)` возвращает ТОЛЬКО форму слова** (`'узла'`), без числа: число подставляет вызывающий (`${n} ${plural(...)}`).
2. **`applyOps(project, ops)` возвращает `{ ok, error?, changed: string[], created: string[] }`**, где `created` — упорядоченный массив реальных id созданных объектов (индексируется как `created[0]`). Карта временных id живёт только внутри модели (`ctx.created`) и наружу не отдаётся.
3. **Временные id `tmp_N` резолвит только `ai.js`** (`resolveTmp`): модель получает уже реальные id. Внутри одного батча модель дополнительно разрешает forward references (`next` / `choices[].next` / `branches[].next` / `startNodeId` на id, созданные позже в том же батче) и `op.id` / `op.to` / `op.from` по карте созданных.
4. **Первый запуск** открывает новый проект. Последний пользовательский документ и восстановление черновика доступны при повторном запуске.
5. **JSON-экспорт** — это сам `.sfproj` плюс маркеры: `{ ...project, format: 'storyforge-export', exportedAt }` (файл открывается в StoryForge).
6. **Поиск поддерживает regex**: чекбокс `#panelSearchRegex`, при включении запрос трактуется как регулярное выражение (`new RegExp(q, 'i')`; битый паттерн даёт сообщение, а не падение), подсветка вызывается как `ui.highlight(text, q, { regex: true })`.
7. **Отладка**: `window.__SF_DEV__` включается `?dev=1` / `--dev`; все `console.log/error` в модулях — только под этим флагом.
8. **Профиль приложения**: `main.js` выбирает `userData` в порядке `SF_USERDATA` → `<app>/.userdata` → системный `app.getPath('userData')` → temp, с проверкой записи. В ограниченных окружениях нужен запуск с `--no-sandbox --user-data-dir=.userdata` (см. README).
9. **Авто-приёмка**: `main.js --selftest` выполняет `tools/selftest-renderer.mjs` внутри окна и пишет `.logs/selftest.json`; в этом режиме `app.js` выставляет `window.__sfTest` и использует изолированные тестовые данные. `--ai-base=<url>` подключает AI-провайдера (заглушку).

## 12. Дизайн-система после прохода unslop (обязательна к соблюдению)

1. **Иконки — только из `src/js/icons.js`**: `import { icon } from './icons.js'`, `icon(name, size)` -> инлайн `<svg class="ic">` с `stroke=1.8`, `currentColor`. Глифы `✓ ✕ ⚠ ⚙ ▾ ↑ ↓` в интерфейсе запрещены (в экспортном Markdown — допустимы).
2. **Токены** (`src/styles.css` и `src/obsidian-theme.css`, `:root` + `[data-theme="light"]`): `--bg/--panel/--panel-2/--sunk/--line/--line-soft/--fg/--fg2/--muted/--fg2-hint`, фиолетовый акцент `--obs-accent #b39aff` (светлая тема `#683eb3`), смысловые `--good/--bad/--warn/--hint`, радиусы `--r-xs 3 / --r-sm 5 / --r-md 7 / --r-lg 11`, шрифты `--font-ui` (Segoe UI, system-ui) и `--font-mono` (Cascadia Mono, Consolas), размеры `--fs-xs 11 / --fs-sm 12 / --fs-md 13 / --fs-lg 15`, кнопка `--btn-primary-bg`.
3. **Правила**: цвет в интерфейсе несёт только акцент (действие, выбор, стартовый узел) и смысловые состояния; тип узла на графе различается меткой и штрихом ребра, а не цветом; числа, id, счётчики, подписи рёбер — `--font-mono` + `tabular-nums`; пилюль-бейджей нет; глубина в тёмной теме — ступени поверхностей и hairline, тень только у плавающего (`--shadow-pop`); капслок и трекинг запрещены; всё на сетке 4px.
4. Каталог действий UI: `.btn-primary` — «бумага» (светлая кнопка с тёмным текстом), `.btn-danger` — контурная, `.btn` и `.input` — `--r-md` внутри карточек `--r-lg`.


---

## 13. Озвучка диалогов (порт Dialogue Voice Studio)

1. **Происхождение**: движок перенесён из `sunakle/dialogue-voice-studio` (VST3-плагин FL Studio, AGPL-3.0) в `src/js/voice/` на чистом JS, без сборщиков — рендер идёт в обычном массиве Float32, прослушивание через Web Audio в рендерере.
2. **Файлы**: `voice/dsp.js` (Noise-LCG, Biquad RBJ, 10 форм волны, Freeverb), `voice/params.js` (SPECS, GROUPS, FACTORY_VOICES 0–3, resolveParams, diffFromPreset, describeVoice), `voice/render.js` (Engine на 24 голоса, renderLine, peakOf), `voice/wav.js` (encodeWav/decodeWav/formatSeconds), `voice.js` (панель).
3. **Модель**. У проекта, персонажа и реплики может быть голос с полями `preset`, `params` и необязательным `sample: {name, data}`. Поле `data` содержит исходные байты WAV в Base64. Реплика с собственным дублем хранит `voiceSeed`. При воспроизведении учитываются голос реплики, голос персонажа и голос проекта в порядке приоритета.
4. **Рендер**: `renderLine({ params, sample, text, seed, mode })` -> `{ left, right, rate, text, reveal, seconds }`. Тайминги как в оригинале: `1000/speed` на букву, многоточие +ellipsis, точки/восклицание/вопрос +period, запятая/точка с запятой/двоеточие/перевод строки +comma, каждый N-й импульс с разбросом высоты (spread) и громкости (jitter); хвост delay/reverb добавляется к длине; seed делает результат детерминированным.
5. **IPC** (`main.js` + `preload.js`, паритет обязателен): `sf:voice:chooseDir`, `sf:voice:writeWav` (имя санитайзится, возврат `{ok, path, size}`), `sf:voice:pickSample` (`{ok, name, bytes}`), `sf:voice:reveal`. Каталог экспорта хранится в настройках как `voiceDir`.
6. **UI**: третья вкладка правой панели `data-tab="voice"` -> `#voiceBody`; фабрика `createVoice({ root, store, ui })` -> `{ render, playNode, stop, exportNode, exportAll, isBusy, dir }`; кнопка `data-act="voice-play"` в шапке line-узла; хоткей `Ctrl+Shift+V`.
7. **AI**: инструменты `get_voice` и `set_voice` (обязателен `preset`, опциональны pitch/speed/duration/release/every/spread/jitter/source/blend); в системном промте есть раздел «ОЗВУЧКА».
8. **Проверки**: `tools/_selftest-voice.mjs` (движок), секция 9 в `tools/verify.mjs` (модель + паритет IPC + стили), раздел 10 в `tools/selftest-renderer.mjs` (вкладка, пресеты, рендер, запись WAV через IPC, прослушивание).

---

## §14. Студия голоса (полный порт интерфейса Dialogue Voice Studio)

Отдельное окно-студия поверх редактора: переносит весь интерфейс плагина VST3
(AGPL-3.0) в StoryForge. Модуль — `src/js/voice-studio.js`, фабрика
`createVoiceStudio({ root, store, ui })` → `{ open(targetId), close(), render(),
isOpen(), setTarget(id), setNode(id), state }`.

**Каркас.** `#studioRoot` (в `index.html`) → `.studio-backdrop` + `.studio-card`
с секциями: `.studio-head` (открыть/сохранить голос, статус, «Компактно», закрыть),
`.studio-target` (персонаж + характер), `canvas.studio-portrait` (ASCII-портрет,
полоса уровня, прогрессивный показ реплики), `.studio-main`, `.studio-row
.studio-actions` (пять кнопок действий), `.studio-tabs` (пять вкладок),
`.studio-page`. Открытие: `Ctrl+Shift+O`, меню «Вид → Студия голоса»
(действие `voice:studio`), кнопка «Студия голоса» во вкладке «Озвучка»
(`[data-voice-act="studio"]`). Закрытие: Esc, крестик, клик по подложке.

**Пять вкладок** (`TABS` в `voice/params.js`, соответствие `TAB_BY_GROUP`):
`0` «Голос» — 19 параметров, `1` «Сэмпл» — 8, `2` «EQ» — 27, `3` «Эффекты» — 33,
`4` «Диалог» — 6; верхний ряд (`tab = -1`) — pitch/duration/speed, скрытая
`tab = 5` — расширенные формы волны. `specsForTab(tab)`, `MAIN_SPECS`, `TABS`
экспортируются; сумма по вкладкам равна `SPECS.length`.

**Режимы рендера** `renderLine({ mode })`: `line` — по тексту, `pulse` — один слог,
`variation` — слог с разбросом, `selection` — выделенный кусок сэмпла целиком
(длительность считается как в `Render.h`; больше 90 с — понятная ошибка).

**Эквалайзер.** `bandCoeffs(params, index, rate)` и `eqResponseDb(params, freq, rate)`
в `voice/dsp.js` дают коэффициенты и АЧХ для кривой; полосы 1–7 рисуются точками,
перетаскивание включает полосу и меняет частоту/усиление.

**Сэмпл.** `sf.voice.pickSample()` → `decodeWav`; волна рисуется на canvas
(мин/макс по пикселю, выделение мышью, зум колесом 1..64), кнопки «Открыть WAV»,
«Слушать выделение», «Сбросить обрезку».

**Экспорт.** `sf.voice.saveWave(name, bytes)` — диалог сохранения WAV;
`sf.voice.makeDir(dir, name)` — подпапка «Вариации голоса» для восьми дублей
(seed `+ i * 7919`); `encodeWave({ left, right, rate, targetRate, channels, bits })`
— 16/24 бита, моно/стерео, линейный ресемплинг. Пресеты голоса — `.dvoice` (JSON
`{ format: 'storyforge-voice', version: 2, preset, params, phrase, seed, sample? }`)
через `sf.voice.savePreset` / `sf.voice.openPreset`.

**Проверки.** `tools/verify.mjs` (секция «7б. Студия голоса»),
`tools/selftest-renderer.mjs` (раздел 10 — девять проверок студии через реальные
клики), `tools/_selftest-voice.mjs` (секция 6 — вкладки, выделение, вариации,
`encodeWave`, EQ).


## §15. Изображения узлов (медиа)

К узлу можно прикрепить фотографии: превью рисуется на карточке графа, сами файлы
лежат внутри `.sfproj` — проект остаётся одним самодостаточным файлом.

**Модель.** `project.media = { id: { id, name, mime, w, h, size, data } }`, где
`data` — data-URL вида `data:image/…;base64,…`. Узел: `media: string[]` (порядок
плиток) и `previewId` (что рисовать на карточке; пусто — первое изображение).
Хелперы модели: `normalizeMediaList`, `normalizeMediaStore`, `MEDIA_BAND = 74`,
`nodePreviewId(node)`, `nodeCardHeight(node)` (90 без фото, 164 с фото).
Операции `applyOps`: `addMedia { media }` (принимает только `data:image/…`,
возвращает id в `created`), `deleteMedia { id }` (чистит ссылки во всех узлах),
`setNodeMedia { id, media, previewId }`. `migrateProject` выбрасывает битые записи
и снимает ссылки на отсутствующие файлы с предупреждением. `autoLayout` считает
высоту строки по фактической высоте карточек.

**IPC.** `sf:media:pick` в `main.js` (`registerMediaIpc()`) — диалог выбора
(png/jpg/jpeg/webp/gif/bmp/avif, до 24 файлов) → `{ name, mime, size, data }`.
В `preload.js` — `window.sf.media.pick()`.

**Модуль `src/js/media.js`.** `prepareImage(source, { maxEdge = 1400, quality = 0.82 })`
— canvas → WebP (при отсутствии поддержки — JPEG 0.86), `pickImages()`,
`filesToMedia(fileList)`, `clipboardImages(event)`, `formatBytes`, `IMAGE_ACCEPT`.

**UI.** Инспектор: секция `.insp-media-section` («+ фото», плитки `.insp-media`,
переключение превью `[data-media-preview]`, удаление `[data-media-del]`, просмотр
`[data-media-open]` в модалке `.media-viewer`). Граф: полоса
`rect.node-media-band` + `image.node-media` (clip-path `#sfMediaClip`), счётчик
`+N`, класс `.drop-target` при перетаскивании; рёбра считаются от фактической
высоты карточки. Способы добавить: кнопка в инспекторе, пункт «Изображения…»
в контекстном меню графа, drag&drop файла на карточку или секцию, `Ctrl+V`.
API в `ui`: `attachImages(nodeId, files)`, `pickMediaForNode(nodeId)`,
`removeNodeMedia(nodeId, mediaId)`, `setNodePreview(nodeId, mediaId)`, `formatBytes`.

**Экспорт.** В Godot `dialogue.json` узел отдаёт `images: [{ name, w, h }]` и
`preview: <имя>`; в Markdown — строку `*Изображения:* \`имя\``.

**Проверки.** `tools/verify.mjs` (секция «10. Изображения узлов»),
`tools/selftest-renderer.mjs` (раздел 11 — тринадцать проверок через реальные
события: импорт, превью на карточке, инспектор, сжатие большой картинки,
переключение превью, удаление, возврат высоты), `tools/_check-media-model.mjs`.


## §16. Обзор сюжета (граф в духе Obsidian Graph view)

Вкладка рабочего пространства показывает весь проект одним облаком. Включено в оболочку как
`#vizRoot` рядом с `#studioRoot`, открывается действием `view:visualizer`
(меню «Вид → Обзор сюжета», хоткей `Ctrl+Shift+G`, кнопка `#btnViz` на панели графа).

**Модуль `src/js/visualizer.js`.** `export function createVisualizer({ root, store, ui })`
возвращает `{ open, close, destroy, isOpen, toggle, render, fit, relayout, state, stats, unsubscribe }`:

- `open()` — строит каркас (кнопки графа, сцена с `canvas.viz-canvas`,
  правая панель), запускает раскладку и подписку на store; `close()` — прячет и глушит
  анимацию; `fit()` — вписывает всё облако в кадр (зум 0.04–6); `relayout()` — заново
  разбрасывает точки и прогоняет физику; `stats` — `{ nodes, links }`.
- Подписка на store: события `project` и `change` пересобирают граф с сохранением позиций
  (`keepPositions`), чтобы облако не прыгало на каждой правке.

**Что в облаке.** Точки: узлы сценария (`line/choice/condition/jump/scene/end`, а также
`note` при включённом фильтре), персонажи, локации, переменные, главы. Связи: `next`,
`choices[].next`, `branches[].next`, автор реплики (`speakerId`), локация (`locationId`),
глава (`chapterId`), эффекты (`effects[].varId`) и чтение переменных в условиях
(поиск имени переменной регуляркой в строке условия). Степень узла считается по связям
и задаёт размер точки и приоритет подписи.

**Физика.** Force-directed на канвасе: отталкивание всех пар (`repulsion`, с отсечкой
дальних пар), пружины по связям (`linkDistance`, `linkStrength`), тяга к центру
(`gravity`), `damping`, ограничение скорости, затухание `alpha`; раскладка
продолжает движение в цикле `requestAnimationFrame`. Стартовые позиции группируются по главам.
Раскладка останавливается после затухания. Жест перетаскивания возобновляет её работу.

**Отрисовка.** Все связи показаны прямыми сплошными отрезками между центрами точек.
Цвет кружка задаёт тип записи, размер зависит от числа связей. Наведение постепенно
окрашивает выбранную точку и её рёбра в фиолетовый, сохраняет цвет её прямых соседей
и приглушает остальной граф. Под точкой появляется название. Уход курсора и переход
на другую точку продолжают анимацию с текущего кадра. DPR ограничен значением 2.

**Правая панель (как в Obsidian).** Секции:
**Фильтры** — поиск `[data-viz="search"]`, чекбоксы `[data-viz="show"][data-key=…]`
для `characters / locations / variables / chapters / notes / orphans`, чекбокс
`[data-viz="reachable"]` («только достижимые», обход от `startNodeId`) и кнопка
`[data-viz="reset"]`; **Группы по главам** — строки `[data-viz="chapter"]` с цветом
и числом узлов, клик скрывает главу (`hiddenChapters`); **Отображение** — пороги
подписей (`[data-viz="labels"]`, 0–12 связей или 13 для подписей при наведении) и размер точек (`[data-viz="size"]`, 0.6–1.8);
**Силы** — отталкивание (`[data-viz="repulsion"]`), длина связи (`[data-viz="link"]`),
тяга (`[data-viz="gravity"]`); секции сворачиваются кнопкой `[data-viz="fold"]`;
внизу счётчик и легенда. В правом верхнем углу холста — параметры и пересборка раскладки.
При открытых параметрах доступны также «Вписать» и «Закрыть».

**Мышь и клавиши.** Колесо — масштаб с якорем под курсором (0.15–6), перетаскивание
пустого места — сдвиг, перетаскивание точки временно удерживает её под курсором. По отпускании или отмене
жеста точка снова подчиняется пружинам и силам раскладки. Короткий клик по точке —
`store.setSelection({ kind, id })` и переход в редактор (персонаж/локация/переменная/
глава и узел открываются в своей вкладке рабочего места), двойной клик — пересборка раскладки,
`Esc` — закрыть (проверяется раньше студии голоса), `Ctrl+Shift+G` — открыть/закрыть.

**Стили.** `.viz-root` (холст центральной вкладки под строкой навигации), `.viz-head`, `.viz-title`,
`.viz-stat`, `.viz-stage`, `.viz-canvas`, `.viz-hint`, `.viz-side`, `.viz-group`,
`.viz-group-head`, `.viz-search`, `.viz-check`, `.viz-toggle`, `.viz-slider`,
`.viz-group-row`, `.viz-dot`, `.viz-legend`. Холст использует `--graph-surface`, панели — токены темы рабочего пространства.

**Проверки.** `tools/verify.mjs` — секция «11. Обзор сюжета» (12 проверок: экспорт
фабрики, canvas вместо DOM, физика, фильтры, поиск и достижимость, подписи, прямые связи и отрисовка точек,
выбор узла, `#vizRoot` и `#btnViz`, подключение в `app.js`, пункт меню, стили);
`tools/selftest-renderer.mjs` — раздел 12 (открытие, размер канваса, все точки и связи,
кластеры глав, «Вписать» охватывает всё, точки разведены физикой, фильтр персонажей,
поиск, переход к узлу, плавное наведение и уход курсора, движение после отпускания,
закрытие, облако на 512 узлах открывается быстрее 6 с).

## §17. Производительность (обязательна к соблюдению)

Требования появились после жалобы на лаги; замеры — в `tools/_probe-perf*.mjs`.

**17.1 Точечная перерисовка графа.** Полная сборка `svg.innerHTML` на 200 карточках
стоит около 50 мс (мутация 15 + лэйаут 35), поэтому `graph.refresh()` обязан
обновлять только изменившееся:

- `nodeSig(n)` — подпись содержимого карточки (тип, хеши текста и заголовка, `next`,
  число и тексты выборов, ветви, спикер, цвет, превью, число медиа, эффекты, старт);
- `posSig(pos)` — подпись позиции; `edgesSignature(edges)` — подпись связей;
- карты `cardSig` / `cardPos` / `cardHeights` и `edgesSig`;
- `patchGraph()` переписывает `el.innerHTML = renderNodeInner(n)` только у карточек с
  изменившейся подписью, двигает `transform` у сдвинутых, пересобирает слой рёбер
  при изменении высоты или состава связей и корректирует геометрию рёбер перемещённых узлов, затем зовёт
  `updateSelectionClasses(true)`;
- `renderNode(n, pos)` — только обёртка `<g class="node-card" transform="translate(...)">`,
  всё содержимое строит `renderNodeInner(n)`;
- `indexElements(edges)` собирает рёбра одним `svg.querySelectorAll('.edges [data-edge]')`;
- при `dragState` перерисовка откладывается (`skippedRender`), полная сборка — только
  по `refresh(true)`.

**17.2 Отсечение текста в SVG (LOD).** Текст — самая дорогая часть лэйаута
(≈0.03 мс на `<text>`, 1239 надписей = 40 мс на кадр); `contain`,
`content-visibility` и вынос из потока не помогают, работает только `display:none`:

- константы `LOD_TEXT_ZOOM = 0.55`, `CULL_MARGIN = 600`;
- `updateLod()` вызывается из `applyTransform()`, после `render()` и `patchGraph()`;
  при зуме ниже порога ставит класс `is-small` на `svg`, иначе считает мировой
  прямоугольник кадра (из `view` и `host.clientWidth/Height`) и ставит `is-far`
  карточкам за пределами; координаты берутся из модели, геометрия DOM не читается;
- CSS: `.graph.is-small .node-card text, .graph .node-card.is-far text { display: none; }`
  и `.graph.is-small .edge-label, .graph.is-small .edge-count { display: none; }`.

**17.3 Тихие правки инспектора.** `apply(ops, label, { refresh = true })`; при
`refresh: false` панель не пересобирается. Список тихих свойств —
`QUIET_PROPS = new Set(['title','text','emotion','speakerId','locationId','tags'])`;
также тихие: текст/цель/условие/подсказка варианта, его эффекты, условие и цель
ветки, эффекты узла. Структурные действия (добавить, удалить, переставить) и смена
выделения перерисовывают панель полностью.

**17.4 Без чтения лэйаута при вводе.** `autosize` с чтением `scrollHeight` заменён
на `updateWordCounter(el, value)`; высоту текстового поля считает CSS
(`.textarea[data-autosize] { field-sizing: content; max-height: 420px; resize: none; overflow-y: auto; }`).

**17.5 Проверки.** `tools/verify.mjs` — секция 12 (наличие `updateLod`,
`LOD_TEXT_ZOOM`, `patchGraph`, `QUIET_PROPS`, отсутствие чтения `scrollHeight`,
CSS-правила, пробники на месте); `tools/selftest-renderer.mjs` — раздел 13
(набор не пересобирает панель, `is-far`/is-small работают, нет длинных задач
>100 мс, правка узла переиспользует карточку).


## 18. Редактирование и рабочее место

- `Store.generation` меняется при открытии или замене проекта. `Store.revision` меняется также при правке, отмене и повторе. Завершение записи относится к той ревизии, которая попала в файл.
- Отложенный ввод фиксируется через `ui.flushEdits()`. Операции `setNodeTexts` принимают `items: [{id, text}]`. Вставка на переход использует одну транзакцию. Для конкретного варианта или ветки операция `retargetEdge` принимает `id`, `kind`, `edgeId`, `to`. Файл проекта и восстановительные копии записываются атомарной заменой через `project-files.cjs`.
- Таблица, схема, текст, быстрый переход и закладки ссылаются на ID одной модели. Параметры вида и закладки хранятся в локальных настройках рабочего места. Для игрового прохождения используется экспортное представление и отдельное состояние переменных.
- Голосовая студия отделяет полную реплику от предпрослушивания. Асинхронный результат принадлежит выбранной реплике и голосу. Правки в ответе AI собираются в черновике и попадают в историю редактора одним действием.
