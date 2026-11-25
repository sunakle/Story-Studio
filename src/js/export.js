// StoryForge — экспорт проекта в Godot (главный формат), Ren'Py, Markdown, JSON и текст.
// Модуль намеренно автономен: не импортирует model.js, чтобы экспорт можно было
// прогонять и тестировать отдельно от UI.

const SCHEMA_VERSION = 1;

// ------------------------------------------------------------------ помощники

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v === null || v === undefined ? '' : String(v));

function byId(list) {
  const map = new Map();
  for (const item of arr(list)) {
    if (isObj(item) && item.id) map.set(item.id, item);
  }
  return map;
}

function nameOf(map, id, fallback = '') {
  const item = map.get(id);
  return item && item.name ? str(item.name) : fallback;
}

/** Все исходящие ссылки узла: [{ kind, index, target }] */
function outgoing(node) {
  const out = [];
  if (!isObj(node)) return out;
  if (node.next) out.push({ kind: 'next', index: -1, target: str(node.next) });
  arr(node.choices).forEach((c, i) => {
    if (c && c.next) out.push({ kind: 'choice', index: i, target: str(c.next) });
  });
  arr(node.branches).forEach((b, i) => {
    if (b && b.next) out.push({ kind: 'branch', index: i, target: str(b.next) });
  });
  return out;
}

/**
 * Разрешает ссылку «сквозь» заметки: note не попадает в экспорт,
 * поэтому цепочка note → note → узел сворачивается в конечную цель.
 */
function resolveTarget(target, nodeMap, seen = new Set()) {
  let id = str(target);
  let guard = 0;
  while (id && nodeMap.has(id) && nodeMap.get(id).type === 'note' && guard++ < 64) {
    if (seen.has(id)) return { id, missing: false, loop: true };
    seen.add(id);
    const note = nodeMap.get(id);
    id = str(note.next);
  }
  if (!id) return { id: '', missing: false, loop: false };
  if (!nodeMap.has(id)) return { id, missing: true, loop: false };
  return { id, missing: false, loop: false };
}

/** Порядок обхода: BFS от стартового узла, затем недостижимые в исходном порядке. */
function orderedNodes(project) {
  const nodes = arr(project.nodes);
  const nodeMap = byId(nodes);
  const startId = str(project.startNodeId);
  const order = [];
  const seen = new Set();
  const queue = [];

  const push = (id) => {
    const r = resolveTarget(id, nodeMap);
    if (r.id && nodeMap.has(r.id) && !seen.has(r.id)) {
      seen.add(r.id);
      queue.push(r.id);
    }
  };

  if (startId && nodeMap.has(startId)) push(startId);
  else if (nodes.length) push(nodes[0].id);

  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    const node = nodeMap.get(id);
    if (!node) continue;
    if (node.type === 'choice') {
      for (const c of arr(node.choices)) if (c && c.next) push(c.next);
      if (node.next) push(node.next);
    } else if (node.type === 'condition') {
      for (const b of arr(node.branches)) if (b && b.next) push(b.next);
      if (node.next) push(node.next);
    } else if (node.next) {
      push(node.next);
    }
  }

  const rest = [];
  for (const n of nodes) {
    if (n && n.id && !seen.has(n.id) && n.type !== 'note') {
      rest.push(n.id);
      seen.add(n.id);
    }
  }
  return { order, unreachable: rest, nodeMap };
}

// ------------------------------------------------------------------ Godot

function godotCondition(cond) {
  const c = str(cond).trim();
  return c || '';
}

/**
 * dialogue.json по §7 спеки.
 * Ключи переменных — их имена (по ним пишутся условия), персонажи/локации — по id.
 */
export function buildGodotDialogue(project) {
  const warnings = [];
  const chars = byId(project.characters);
  const locs = byId(project.locations);
  const varsById = byId(project.variables);
  const nodeMap = byId(project.nodes);

  const varName = (varId) => {
    const v = varsById.get(varId);
    return v && v.name ? str(v.name) : str(varId);
  };

  const effectsOut = (effects) =>
    arr(effects)
      .filter((e) => isObj(e) && e.varId)
      .map((e) => ({ var: varName(e.varId), op: str(e.op) || 'set', value: e.value }));

  const characters = {};
  for (const c of arr(project.characters)) {
    if (!c || !c.id) continue;
    characters[c.id] = {
      name: str(c.name) || str(c.id),
      color: str(c.color) || '#7c9cff',
      role: str(c.role),
    };
  }

  const locations = {};
  for (const l of arr(project.locations)) {
    if (!l || !l.id) continue;
    locations[l.id] = { name: str(l.name) || str(l.id), atmosphere: str(l.atmosphere) };
  }

  const variables = {};
  for (const v of arr(project.variables)) {
    if (!v || !v.name) continue;
    variables[str(v.name)] = {
      type: str(v.type) || 'number',
      initial: v.initial === undefined ? 0 : v.initial,
      description: str(v.description),
    };
  }

  const nodes = {};
  const link = (rawTarget, where) => {
    const r = resolveTarget(rawTarget, nodeMap);
    if (r.missing) {
      warnings.push(`${where}: ссылка на несуществующий узел «${r.id}»`);
      return { id: r.id, broken: true };
    }
    return { id: r.id, broken: false };
  };

  for (const node of arr(project.nodes)) {
    if (!node || !node.id) continue;
    if (node.type === 'note') continue; // заметки автора в экспорт не попадают
    const where = `Узел ${node.id}`;
    const base = { type: str(node.type) || 'line' };
    if (node.chapterId) base.chapter = str(node.chapterId);

    const speakerId = str(node.speakerId);
    if (speakerId) {
      base.character = speakerId;
      base.speaker = nameOf(chars, speakerId, speakerId);
      if (!chars.has(speakerId)) warnings.push(`${where}: персонаж «${speakerId}» не найден`);
    }

    const locationId = str(node.locationId);
    if (locationId) {
      base.location = nameOf(locs, locationId, locationId);
      base.location_id = locationId;
      if (!locs.has(locationId)) warnings.push(`${where}: локация «${locationId}» не найдена`);
    }

    if (node.emotion) base.emotion = str(node.emotion);
    if (node.text !== undefined && node.text !== null && str(node.text) !== '') base.text = str(node.text);
    if (node.title) base.title = str(node.title);
    if (arr(node.tags).length) base.tags = arr(node.tags).map(str);
    if (arr(node.effects).length) base.effects = effectsOut(node.effects);

    // Изображения узла: в Godot попадают имена из библиотеки проекта —
    // сами файлы лежат в .sfproj, движку достаточно знать, что показать.
    const mediaLib = isObj(project.media) ? project.media : {};
    const images = arr(node.media)
      .map((id) => mediaLib[str(id)])
      .filter((m) => m && m.data)
      .map((m) => ({ name: str(m.name), w: m.w || 0, h: m.h || 0 }));
    if (images.length) {
      base.images = images;
      if (str(node.previewId)) base.preview = str((mediaLib[str(node.previewId)] || {}).name);
    }

    const entry = Object.assign(base, {});

    if (node.type === 'choice') {
      entry.choices = arr(node.choices).map((c, i) => {
        const ch = isObj(c) ? c : {};
        const out = {
          id: str(ch.id) || `o_${node.id}_${i + 1}`,
          text: str(ch.text),
        };
        if (ch.hint) out.hint = str(ch.hint);
        const l = link(ch.next, `${where}, вариант «${out.text || out.id}»`);
        out.next = l.id || null;
        if (l.broken) out.broken = true;
        if (ch.condition) out.condition = godotCondition(ch.condition);
        if (arr(ch.effects).length) out.effects = effectsOut(ch.effects);
        return out;
      });
      const l = link(node.next, `${where} (запасной переход)`);
      entry.next = l.id || null;
      if (l.broken) entry.broken = true;
    } else if (node.type === 'condition') {
      entry.branches = arr(node.branches).map((b, i) => {
        const br = isObj(b) ? b : {};
        const l = link(br.next, `${where}, ветка ${i + 1}`);
        const out = {
          id: str(br.id) || `b_${node.id}_${i + 1}`,
          condition: godotCondition(br.condition),
          next: l.id || null,
        };
        if (l.broken) out.broken = true;
        return out;
      });
      const l = link(node.next, `${where} (ветка «иначе»)`);
      entry.next = l.id || null;
      if (l.broken) entry.broken = true;
    } else if (node.type === 'end') {
      entry.next = null;
    } else {
      const l = link(node.next, where);
      entry.next = l.id || null;
      if (l.broken) entry.broken = true;
    }

    if (entry.next === null && node.type !== 'end' && !node.next) {
      // узел без продолжения — не ошибка экспорта, просто финал ветки
      entry.terminal = true;
    }

    nodes[str(node.id)] = entry;
  }

  const startResolved = resolveTarget(project.startNodeId, nodeMap);
  if (!startResolved.id || startResolved.missing) {
    warnings.push(`Стартовый узел «${str(project.startNodeId) || '—'}» не найден`);
  }

  return {
    version: SCHEMA_VERSION,
    title: str(project.meta && project.meta.title) || 'Без названия',
    start: startResolved.id || '',
    author: str(project.meta && project.meta.author),
    characters,
    locations,
    variables,
    nodes,
    warnings,
  };
}

export function buildGodotRunner() {
  return `# dialogue_runner.gd — исполнение диалога StoryForge в Godot 4.x
# Сгенерировано StoryForge. Файл самодостаточен: положите рядом с dialogue.json.
#
# Использование:
#   var runner := DialogueRunner.new()
#   add_child(runner)
#   runner.line_shown.connect(_on_line)
#   runner.choices_shown.connect(_on_choices)
#   runner.finished.connect(_on_finished)
#   runner.load_dialogue("res://dialogue.json")
#   runner.start()
#   runner.advance()      # после показа реплики
#   runner.choose(0)      # при выборе варианта

class_name DialogueRunner
extends Node

signal line_shown(speaker: String, text: String, emotion: String)
signal choices_shown(choices: Array)
signal scene_changed(location: String)
signal finished()

## Сколько узлов подряд можно пройти автоматически (jump/condition), защита от зацикливания.
const MAX_AUTO_STEPS := 512

var dialogue: Dictionary = {}
var nodes: Dictionary = {}
var characters: Dictionary = {}
var locations: Dictionary = {}
var vars: Dictionary = {}

var current_id: String = ""
var current_node: Dictionary = {}
var running: bool = false

var _choices: Array = []


func load_dialogue(path: String) -> bool:
	var text := FileAccess.get_file_as_string(path)
	if text.is_empty():
		push_error("DialogueRunner: не удалось прочитать файл " + path)
		return false
	var data = JSON.parse_string(text)
	if typeof(data) != TYPE_DICTIONARY:
		push_error("DialogueRunner: файл не является корректным JSON: " + path)
		return false
	load_from_dict(data)
	return true


func load_from_dict(data: Dictionary) -> void:
	dialogue = data
	nodes = data.get("nodes", {})
	characters = data.get("characters", {})
	locations = data.get("locations", {})
	vars = {}
	var declared: Dictionary = data.get("variables", {})
	for key in declared.keys():
		var spec = declared[key]
		if typeof(spec) == TYPE_DICTIONARY:
			vars[String(key)] = spec.get("initial", 0)
		else:
			vars[String(key)] = spec
	running = false
	current_id = ""
	current_node = {}
	_choices = []


func start(node_id: String = "") -> void:
	var id := node_id
	if id.is_empty():
		id = String(dialogue.get("start", ""))
	if id.is_empty():
		push_warning("DialogueRunner: не задан стартовый узел")
		_finish()
		return
	running = true
	_enter(id)


func advance() -> void:
	if not running or current_node.is_empty():
		return
	var nxt := String(current_node.get("next", ""))
	if nxt.is_empty():
		_finish()
		return
	_enter(nxt)


func choose(index: int) -> void:
	if _choices.is_empty():
		push_warning("DialogueRunner: выбора сейчас нет")
		return
	if index < 0 or index >= _choices.size():
		push_warning("DialogueRunner: неверный индекс выбора " + str(index))
		return
	var option: Dictionary = _choices[index]
	_choices = []
	_apply_effects(option.get("effects", []))
	var nxt := String(option.get("next", ""))
	if nxt.is_empty():
		_finish()
		return
	_enter(nxt)


func get_var(name: String, default_value = 0):
	return vars.get(name, default_value)


func set_var(name: String, value) -> void:
	vars[name] = value


func is_running() -> bool:
	return running


func speaker_name(node: Dictionary) -> String:
	var cid := String(node.get("character", ""))
	if not cid.is_empty() and characters.has(cid):
		return String(characters[cid].get("name", cid))
	return String(node.get("speaker", ""))


func location_name(node: Dictionary) -> String:
	var lid := String(node.get("location_id", ""))
	if not lid.is_empty() and locations.has(lid):
		return String(locations[lid].get("name", lid))
	return String(node.get("location", ""))


func _enter(id: String) -> void:
	var nid := id
	var guard := 0
	while guard < MAX_AUTO_STEPS:
		guard += 1
		if nid.is_empty():
			_finish()
			return
		if not nodes.has(nid):
			push_warning("DialogueRunner: узел не найден: " + nid)
			_finish()
			return
		var node: Dictionary = nodes[nid]
		current_id = nid
		current_node = node
		_apply_effects(node.get("effects", []))

		match String(node.get("type", "line")):
			"line":
				line_shown.emit(speaker_name(node), String(node.get("text", "")), String(node.get("emotion", "")))
				return
			"scene":
				var loc := location_name(node)
				scene_changed.emit(loc)
				line_shown.emit(loc, String(node.get("text", "")), "")
				return
			"choice":
				var options := _available_choices(node)
				if options.is_empty():
					nid = String(node.get("next", ""))
					current_node = {}
					continue
				_choices = options
				choices_shown.emit(options)
				return
			"condition":
				nid = _resolve_branch(node)
				current_node = {}
				continue
			"jump":
				nid = String(node.get("next", ""))
				current_node = {}
				continue
			"end":
				var final_text := String(node.get("text", ""))
				if not final_text.is_empty():
					line_shown.emit(speaker_name(node), final_text, "")
				_finish()
				return
			_:
				nid = String(node.get("next", ""))
				current_node = {}
				continue
	_finish()


func _finish() -> void:
	running = false
	_choices = []
	current_node = {}
	current_id = ""
	finished.emit()


func _available_choices(node: Dictionary) -> Array:
	var result: Array = []
	var raw: Array = node.get("choices", [])
	for i in raw.size():
		var c = raw[i]
		if typeof(c) != TYPE_DICTIONARY:
			continue
		var cond := String(c.get("condition", ""))
		if not cond.is_empty() and not eval_condition(cond):
			continue
		result.append({
			"index": result.size(),
			"id": String(c.get("id", "o_" + str(i))),
			"text": String(c.get("text", "")),
			"hint": String(c.get("hint", "")),
			"next": String(c.get("next", "")),
			"effects": c.get("effects", []),
		})
	return result


func _resolve_branch(node: Dictionary) -> String:
	var raw: Array = node.get("branches", [])
	for b in raw:
		if typeof(b) != TYPE_DICTIONARY:
			continue
		if eval_condition(String(b.get("condition", ""))):
			return String(b.get("next", ""))
	return String(node.get("next", ""))


func _apply_effects(effects) -> void:
	if typeof(effects) != TYPE_ARRAY:
		return
	for e in effects:
		if typeof(e) != TYPE_DICTIONARY:
			continue
		var var_name := String(e.get("var", ""))
		if var_name.is_empty():
			continue
		var op := String(e.get("op", "set"))
		var value = e.get("value", 0)
		var current = vars.get(var_name, 0)
		match op:
			"+=":
				if typeof(current) == TYPE_INT and typeof(value) == TYPE_INT:
					vars[var_name] = current + value
				else:
					vars[var_name] = _to_float(current) + _to_float(value)
			"-=":
				if typeof(current) == TYPE_INT and typeof(value) == TYPE_INT:
					vars[var_name] = current - value
				else:
					vars[var_name] = _to_float(current) - _to_float(value)
			"toggle":
				vars[var_name] = not bool(current)
			_:
				vars[var_name] = value


func _to_float(value) -> float:
	match typeof(value):
		TYPE_INT, TYPE_FLOAT:
			return float(value)
		TYPE_BOOL:
			return 1.0 if value else 0.0
		_:
			var s := String(value)
			return s.to_float() if s.is_valid_float() else 0.0


## Вычисляет условие вида "trust_mark >= 3 && found_key" через Expression.
func eval_condition(condition: String) -> bool:
	var c := condition.strip_edges()
	if c.is_empty():
		return true
	c = c.replace("&&", " and ").replace("||", " or ")
	var bang := RegEx.new()
	bang.compile("!(?!=)")
	c = bang.sub(c, " not ", true)

	var names := PackedStringArray()
	var values := []
	for key in vars.keys():
		names.append(String(key))
		values.append(vars[key])

	var expr := Expression.new()
	if expr.parse(c, names) != OK:
		push_warning("DialogueRunner: не удалось разобрать условие: " + condition)
		return false
	var result = expr.execute(values, null, false)
	if expr.has_execute_failed():
		push_warning("DialogueRunner: ошибка вычисления условия: " + condition)
		return false
	return bool(result)
`;
}

export function buildGodotReadme(project) {
  const title = str(project.meta && project.meta.title) || 'Без названия';
  const stats = {
    nodes: arr(project.nodes).filter((n) => n && n.type !== 'note').length,
    characters: arr(project.characters).length,
    locations: arr(project.locations).length,
    variables: arr(project.variables).length,
  };
  return `# ${title} — экспорт StoryForge для Godot 4

Комплект из трёх файлов:

| Файл | Что это |
|---|---|
| \`dialogue.json\` | Весь сценарий: узлы, персонажи, локации, переменные |
| \`dialogue_runner.gd\` | Класс \`DialogueRunner\` — проигрывает сценарий |
| \`README.md\` | Этот файл |

Сценарий: ${stats.nodes} узлов, ${stats.characters} персонажей, ${stats.locations} локаций, ${stats.variables} переменных.

## 1. Куда положить

Скопируйте все три файла в проект Godot 4.x, например в \`res://story/\`.

## 2. Подключение

\`\`\`gdscript
extends Control

var runner: DialogueRunner

func _ready() -> void:
	runner = DialogueRunner.new()
	add_child(runner)
	runner.line_shown.connect(_on_line)
	runner.choices_shown.connect(_on_choices)
	runner.scene_changed.connect(_on_scene)
	runner.finished.connect(_on_finished)

	if not runner.load_dialogue("res://story/dialogue.json"):
		push_error("Сценарий не загрузился")
		return
	runner.start()

func _on_line(speaker: String, text: String, emotion: String) -> void:
	print("%s%s: %s" % [speaker, (" (" + emotion + ")") if not emotion.is_empty() else "", text])
	# Здесь покажите текст в UI и ждите действия игрока:
	# await get_tree().create_timer(0.2).timeout
	# runner.advance()

func _on_choices(choices: Array) -> void:
	for c in choices:
		print("[%d] %s" % [c["index"], c["text"]])
	# Здесь постройте кнопки и вызовите runner.choose(index)

func _on_scene(location: String) -> void:
	print("— " + location + " —")

func _on_finished() -> void:
	print("Сценарий закончен")
\`\`\`

## 3. Минимальный UI

Если лень верстать: положите на сцену \`Label\` (текст), \`VBoxContainer\` (варианты) и \`Button\` «Далее».
В \`_on_line\` заполняйте \`Label.text\`, в \`_on_choices\` создавайте кнопки с
\`pressed.connect(func(): runner.choose(i))\`, по «Далее» вызывайте \`runner.advance()\`.

## 4. Переменные и условия

Переменные живут в \`runner.vars\` (словарь). Начальные значения берутся из \`dialogue.json\`.
Условия вычисляются через \`Expression\`, поддерживаются \`== != >= <= > < && || !\`, числа,
строки в кавычках и имена переменных. Своя проверка:

\`\`\`gdscript
if runner.eval_condition("trust_mark >= 3 && found_key"):
	print("Марк доверяет")
\`\`\`

Эффекты (\`"effects": [{"var": "trust_mark", "op": "+=", "value": 1}]\`) применяются
автоматически при входе в узел и при выборе варианта.

## 5. Сигналы

- \`line_shown(speaker, text, emotion)\` — показать реплику.
- \`choices_shown(choices)\` — показать варианты; в каждом \`{index, id, text, hint, next, effects}\`.
- \`scene_changed(location)\` — сменилась локация (узел \`scene\`).
- \`finished()\` — ветка закончилась.

## 6. Про битые ссылки

Если в сценарии были ссылки на несуществующие узлы, у таких узлов в \`dialogue.json\`
стоит \`"broken": true\`, а \`next\` указывает на отсутствующий id. \`DialogueRunner\`
в этом случае пишет предупреждение и завершает ветку — игра не падает.

Сгенерировано StoryForge. Правки лучше вносить в редакторе и экспортировать заново.
`;
}

// ------------------------------------------------------------------ Ren'Py

const renpyIdent = (s) => {
  const cleaned = str(s)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return cleaned || 'narrator';
};

const renpyString = (s) =>
  str(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n');

export function renpyCondition(cond) {
  let c = str(cond).trim();
  if (!c) return '';
  c = c.replace(/&&/g, ' and ').replace(/\|\|/g, ' or ');
  c = c.replace(/(^|[^=!<>])!(?!=)/g, '$1 not ');
  c = c.replace(/\btrue\b/gi, 'True').replace(/\bfalse\b/gi, 'False').replace(/\bnull\b/gi, 'None');
  return c.replace(/\s+/g, ' ').trim();
}

export function buildRenpy(project) {
  const warnings = [];
  const lines = [];
  const chars = byId(project.characters);
  const locs = byId(project.locations);
  const varsById = byId(project.variables);
  const nodeMap = byId(project.nodes);
  const chapters = byId(project.chapters);
  const { order, unreachable } = orderedNodes(project);

  const varName = (varId) => {
    const v = varsById.get(varId);
    return v && v.name ? str(v.name) : renpyIdent(varId);
  };
  const charIdent = (charId) => renpyIdent(charId);

  const title = str(project.meta && project.meta.title) || 'Без названия';
  lines.push(`# ${title}`);
  lines.push(`# Экспорт StoryForge для Ren'Py. Кодировка UTF-8.`);
  if (project.meta && project.meta.author) lines.push(`# Автор: ${str(project.meta.author)}`);
  lines.push('');

  // персонажи
  if (arr(project.characters).length) {
    lines.push('# --- Персонажи ---');
    for (const c of arr(project.characters)) {
      if (!c || !c.id) continue;
      const color = str(c.color);
      const ident = charIdent(c.id);
      const args = [`"${renpyString(c.name || c.id)}"`];
      if (color) args.push(`color="${color}"`);
      lines.push(`define ${ident} = Character(${args.join(', ')})`);
    }
    lines.push('');
  }

  // переменные
  if (arr(project.variables).length) {
    lines.push('# --- Переменные ---');
    for (const v of arr(project.variables)) {
      if (!v || !v.name) continue;
      const name = renpyIdent(v.name);
      let init;
      if (v.type === 'bool') init = v.initial ? 'True' : 'False';
      else if (v.type === 'string') init = `"${renpyString(v.initial || '')}"`;
      else init = Number.isFinite(Number(v.initial)) ? Number(v.initial) : 0;
      lines.push(`default ${name} = ${init}`);
    }
    lines.push('');
  }

  const emitEffects = (effects, indent) => {
    for (const e of arr(effects)) {
      if (!isObj(e) || !e.varId) continue;
      const name = varName(e.varId);
      const value = typeof e.value === 'number' ? e.value : `"${renpyString(e.value)}"`;
      if (e.op === '+=') lines.push(`${indent}$ ${name} += ${value}`);
      else if (e.op === '-=') lines.push(`${indent}$ ${name} -= ${value}`);
      else if (e.op === 'toggle') lines.push(`${indent}$ ${name} = not ${name}`);
      else lines.push(`${indent}$ ${name} = ${value}`);
    }
  };

  const jumpTo = (target, indent) => {
    const r = resolveTarget(target, nodeMap);
    if (!r.id) return;
    if (r.missing) {
      warnings.push(`Ren'Py: ссылка на несуществующий узел «${r.id}»`);
      lines.push(`${indent}# ОШИБКА: переход на несуществующий узел ${r.id}`);
      return;
    }
    lines.push(`${indent}jump ${r.id}`);
  };

  // точка входа
  const startResolved = resolveTarget(project.startNodeId, nodeMap);
  lines.push('# --- Точка входа ---');
  lines.push('label start:');
  if (startResolved.id && !startResolved.missing) {
    lines.push(`    jump ${startResolved.id}`);
  } else {
    warnings.push(`Ren\'Py: стартовый узел «${str(project.startNodeId) || '—'}» не найден`);
    lines.push('    # ОШИБКА: стартовый узел не найден');
    lines.push('    return');
  }
  lines.push('');

  // главы как ярлыки-входы
  for (const ch of arr(project.chapters)) {
    if (!ch || !ch.id) continue;
    const first = arr(project.nodes).find((n) => n && n.chapterId === ch.id && n.type !== 'note');
    if (!first) continue;
    lines.push(`# --- Глава: ${str(ch.name) || str(ch.id)} ---`);
    lines.push(`label ${renpyIdent(ch.id)}:`);
    lines.push(`    jump ${first.id}`);
    lines.push('');
  }

  // узлы в порядке обхода
  const emitted = new Set();
  const emitNode = (id) => {
    if (emitted.has(id)) return;
    const node = nodeMap.get(id);
    if (!node || node.type === 'note') return;
    emitted.add(id);

    const chapter = node.chapterId ? chapters.get(node.chapterId) : null;
    lines.push(`# ${chapter ? `${str(chapter.name)} · ` : ''}${id} (${str(node.type)})`);
    lines.push(`label ${id}:`);

    const text = str(node.text);
    const speakerId = str(node.speakerId);
    const isChar = speakerId && chars.has(speakerId);
    const say = (body, indent = '    ') => {
      if (!body) return;
      if (isChar) lines.push(`${indent}${charIdent(speakerId)} "${renpyString(body)}"`);
      else lines.push(`${indent}narrator "${renpyString(body)}"`);
    };

    emitEffects(node.effects, '    ');

    switch (node.type) {
      case 'line':
        say(text);
        jumpTo(node.next, '    ');
        break;

      case 'scene': {
        const locName = nameOf(locs, node.locationId, '');
        if (locName) lines.push(`    scene bg ${renpyIdent(locName)}`);
        if (locName) lines.push(`    # локация: ${locName}`);
        say(text);
        jumpTo(node.next, '    ');
        break;
      }

      case 'choice': {
        if (text) say(text);
        const choices = arr(node.choices).filter((c) => isObj(c) && str(c.text) !== '');
        if (!choices.length) {
          lines.push('    # ОШИБКА: у выбора нет вариантов');
          jumpTo(node.next, '    ');
          break;
        }
        lines.push('    menu:');
        for (const c of choices) {
          const cond = renpyCondition(c.condition);
          const head = `        "${renpyString(c.text)}"`;
          lines.push(cond ? `${head} if ${cond}:` : `${head}:`);
          emitEffects(c.effects, '            ');
          if (c.next) jumpTo(c.next, '            ');
          else lines.push('            # ОШИБКА: вариант без перехода');
        }
        if (node.next) jumpTo(node.next, '    ');
        break;
      }

      case 'condition': {
        const branches = arr(node.branches).filter(isObj);
        let first = true;
        for (const b of branches) {
          const cond = renpyCondition(b.condition);
          if (!cond) continue;
          lines.push(`    ${first ? 'if' : 'elif'} ${cond}:`);
          if (b.next) jumpTo(b.next, '        ');
          else lines.push('        # ОШИБКА: ветка без перехода');
          first = false;
        }
        if (!first) {
          lines.push('    else:');
          if (node.next) jumpTo(node.next, '        ');
          else lines.push('        pass');
        } else {
          jumpTo(node.next, '    ');
        }
        break;
      }

      case 'jump':
        jumpTo(node.next, '    ');
        break;

      case 'end':
        if (text) say(text);
        lines.push('    return');
        break;

      default:
        if (text) say(text);
        jumpTo(node.next, '    ');
        break;
    }
    lines.push('');
  };

  for (const id of order) emitNode(id);
  for (const id of unreachable) {
    if (!emitted.has(id)) {
      lines.push(`# ВНИМАНИЕ: узел недостижим из стартового`);
      emitNode(id);
    }
  }

  return { content: lines.join('\n') + '\n', warnings };
}

// ------------------------------------------------------------------ Markdown

export function buildMarkdown(project) {
  const warnings = [];
  const lines = [];
  const chars = byId(project.characters);
  const locs = byId(project.locations);
  const varsById = byId(project.variables);
  const nodeMap = byId(project.nodes);
  const chapters = byId(project.chapters);
  const { order, unreachable } = orderedNodes(project);

  const title = str(project.meta && project.meta.title) || 'Без названия';
  lines.push(`# ${title}`);
  lines.push('');
  const meta = project.meta || {};
  if (meta.author) lines.push(`**Автор:** ${str(meta.author)}  `);
  if (meta.description) lines.push(`**Описание:** ${str(meta.description)}  `);
  lines.push(`**Узлов:** ${arr(project.nodes).filter((n) => n && n.type !== 'note').length} · **Персонажей:** ${arr(project.characters).length} · **Локаций:** ${arr(project.locations).length}`);
  lines.push('');

  const effectText = (effects) =>
    arr(effects)
      .filter((e) => isObj(e) && e.varId)
      .map((e) => {
        const v = varsById.get(e.varId);
        const name = v && v.name ? str(v.name) : str(e.varId);
        if (e.op === 'toggle') return `${name} = !${name}`;
        return `${name} ${str(e.op) || 'set'} ${e.value}`;
      })
      .join(', ');

  const textOf = (node) => str(node.text);
  const speakerOf = (node) => {
    const sp = chars.get(str(node.speakerId));
    return sp ? str(sp.name).toUpperCase() : '';
  };

  let lastChapter = null;
  const unreachableSet = new Set(unreachable);

  const writeNode = (id) => {
    const node = nodeMap.get(id);
    if (!node || node.type === 'note') return;
    const chapterId = str(node.chapterId);
    if (chapterId !== lastChapter) {
      lastChapter = chapterId;
      const ch = chapters.get(chapterId);
      lines.push(`## ${ch ? str(ch.name) : 'Без главы'}`);
      lines.push('');
    }
    if (unreachableSet.has(id)) {
      lines.push(`> ⚠ Недостижимый узел \`${id}\``);
      lines.push('');
    }

    const locName = nameOf(locs, node.locationId, '');
    if (locName) {
      lines.push(`*${locName}*`);
      lines.push('');
    }

    const eff = effectText(node.effects);
    if (eff) {
      lines.push(`\`[${eff}]\``);
      lines.push('');
    }

    const mediaLib = isObj(project.media) ? project.media : {};
    const mediaNames = arr(node.media)
      .map((mid) => str((mediaLib[str(mid)] || {}).name))
      .filter(Boolean);
    if (mediaNames.length) {
      lines.push(`*Изображения:* ${mediaNames.map((n) => `\`${n}\``).join(', ')}`);
      lines.push('');
    }

    // помечает битый `next` в текстовых форматах
    const noteBrokenNext = () => {
      if (!node.next) return;
      const r = resolveTarget(node.next, nodeMap);
      if (r.missing) {
        lines.push(`> # ОШИБКА: переход на несуществующий узел ${r.id}`);
        lines.push('');
        warnings.push(`Markdown: узел ${id} — переход на несуществующий узел ${r.id}`);
      }
    };

    switch (node.type) {
      case 'line': {
        const sp = speakerOf(node);
        const emo = node.emotion ? ` *(${str(node.emotion)})*` : '';
        lines.push(sp ? `**${sp}:**${emo} ${textOf(node)}` : textOf(node));
        lines.push('');
        noteBrokenNext();
        break;
      }
      case 'scene': {
        lines.push(`*${locName || 'Сцена'}* — ${textOf(node)}`);
        lines.push('');
        noteBrokenNext();
        break;
      }
      case 'choice': {
        if (textOf(node)) {
          lines.push(textOf(node));
          lines.push('');
        }
        for (const c of arr(node.choices)) {
          if (!isObj(c)) continue;
          const cond = str(c.condition).trim();
          const hint = str(c.hint).trim();
          const parts = [`- **${str(c.text)}**`];
          if (cond) parts.push(`[если ${cond}]`);
          if (hint) parts.push(`_(${hint})_`);
          const cEff = effectText(c.effects);
          if (cEff) parts.push(`\`[${cEff}]\``);
          const r = resolveTarget(c.next, nodeMap);
          if (r.missing) {
            parts.push(`# ОШИБКА: переход на несуществующий узел ${r.id}`);
            warnings.push(`Markdown: вариант «${str(c.text)}» ведёт на несуществующий узел ${r.id}`);
          }
          lines.push(parts.join(' '));
        }
        if (node.next) {
          const r = resolveTarget(node.next, nodeMap);
          if (r.missing) {
            lines.push(`- _(иначе)_ # ОШИБКА: переход на несуществующий узел ${r.id}`);
            warnings.push(`Markdown: узел ${id} — запасной переход на несуществующий узел ${r.id}`);
          } else {
            lines.push(`- _(иначе → ${r.id})_`);
          }
        }
        lines.push('');
        break;
      }
      case 'condition': {
        lines.push('**Условия:**');
        for (const b of arr(node.branches)) {
          if (!isObj(b)) continue;
          const r = resolveTarget(b.next, nodeMap);
          const cond = str(b.condition).trim() || '—';
          if (r.missing) {
            lines.push(`- если \`${cond}\` → # ОШИБКА: несуществующий узел ${r.id}`);
            warnings.push(`Markdown: узел ${id} — ветка на несуществующий узел ${r.id}`);
          } else {
            lines.push(`- если \`${cond}\` → ${r.id}`);
          }
        }
        if (node.next) {
          const r = resolveTarget(node.next, nodeMap);
          lines.push(r.missing ? `- иначе → # ОШИБКА: несуществующий узел ${r.id}` : `- иначе → ${r.id}`);
          if (r.missing) warnings.push(`Markdown: узел ${id} — ветка «иначе» на несуществующий узел ${r.id}`);
        }
        lines.push('');
        break;
      }
      case 'jump': {
        const r = resolveTarget(node.next, nodeMap);
        lines.push(r.missing ? `→ # ОШИБКА: переход на несуществующий узел ${r.id}` : `→ *переход к ${r.id}*`);
        if (r.missing) warnings.push(`Markdown: узел ${id} — переход на несуществующий узел ${r.id}`);
        lines.push('');
        break;
      }
      case 'end':
        if (textOf(node)) {
          const sp = speakerOf(node);
          lines.push(sp ? `**${sp}:** ${textOf(node)}` : textOf(node));
          lines.push('');
        }
        lines.push('— КОНЕЦ —');
        lines.push('');
        break;
      default:
        if (textOf(node)) {
          lines.push(textOf(node));
          lines.push('');
        }
        break;
    }
  };

  for (const id of order) writeNode(id);
  for (const id of unreachable) writeNode(id);

  return { content: lines.join('\n') + '\n', warnings };
}

// ------------------------------------------------------------------ JSON

export function buildJson(project) {
  // Дамп — это сам проект (.sfproj): такой файл можно сразу открыть в StoryForge.
  // exportAt/format лежат рядом с полями проекта, а не заворачивают его целиком,
  // чтобы структура оставалась узнаваемой для внешних инструментов.
  const dump = {
    ...project,
    format: 'storyforge-export',
    exportedAt: new Date().toISOString(),
  };
  return { content: JSON.stringify(dump, null, 2), warnings: [] };
}

// ------------------------------------------------------------------ текст (буфер обмена)

function buildPlainText(project) {
  const chars = byId(project.characters);
  const locs = byId(project.locations);
  const nodeMap = byId(project.nodes);
  const chapters = byId(project.chapters);
  const { order, unreachable } = orderedNodes(project);
  const lines = [];
  let lastChapter = null;

  const walk = (id) => {
    const node = nodeMap.get(id);
    if (!node || node.type === 'note') return;
    const chId = str(node.chapterId);
    if (chId !== lastChapter) {
      lastChapter = chId;
      const ch = chapters.get(chId);
      lines.push('');
      lines.push(`=== ${ch ? str(ch.name) : 'Без главы'} ===`);
      lines.push('');
    }
    const locName = nameOf(locs, node.locationId, '');
    if (locName) lines.push(`[${locName}]`);
    const sp = chars.get(str(node.speakerId));
    const prefix = sp ? `${str(sp.name).toUpperCase()}: ` : '';
    const emo = node.emotion ? ` (${str(node.emotion)})` : '';

    if (node.type === 'choice') {
      if (str(node.text)) lines.push(str(node.text));
      arr(node.choices).forEach((c, i) => {
        if (!isObj(c)) return;
        const cond = str(c.condition).trim();
        lines.push(`  ${i + 1}) ${str(c.text)}${cond ? `  [если ${cond}]` : ''}`);
      });
    } else if (node.type === 'condition') {
      for (const b of arr(node.branches)) {
        if (!isObj(b)) continue;
        lines.push(`  если ${str(b.condition) || '—'} → ${str(b.next)}`);
      }
      if (node.next) lines.push(`  иначе → ${str(node.next)}`);
    } else if (node.type === 'end') {
      if (str(node.text)) lines.push(`${prefix}${str(node.text)}`);
      lines.push('— КОНЕЦ —');
    } else if (node.type === 'jump') {
      lines.push(`→ ${str(node.next)}`);
    } else if (str(node.text)) {
      lines.push(`${prefix}${str(node.text)}${emo}`);
    }
  };

  for (const id of order) walk(id);
  for (const id of unreachable) walk(id);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ------------------------------------------------------------------ общий вход

export function buildExport(project, format) {
  if (!isObj(project)) {
    throw new Error('Нет проекта для экспорта');
  }
  const title = str(project.meta && project.meta.title) || 'scenario';
  const safeName = title.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'scenario';

  switch (format) {
    case 'godot': {
      const dialogue = buildGodotDialogue(project);
      const warnings = dialogue.warnings.slice();
      const json = JSON.stringify(dialogue, null, 2);
      return {
        kind: 'dir',
        files: [
          { name: 'dialogue.json', content: json },
          { name: 'dialogue_runner.gd', content: buildGodotRunner() },
          { name: 'README.md', content: buildGodotReadme(project) },
        ],
        warnings,
      };
    }
    case 'renpy': {
      const out = buildRenpy(project);
      return {
        kind: 'dir',
        files: [{ name: `${safeName}.rpy`, content: out.content }],
        warnings: out.warnings,
      };
    }
    case 'markdown': {
      const out = buildMarkdown(project);
      return {
        kind: 'dir',
        files: [{ name: `${safeName}.md`, content: out.content }],
        warnings: out.warnings,
      };
    }
    case 'json': {
      const out = buildJson(project);
      return {
        kind: 'dir',
        files: [{ name: `${safeName}.json`, content: out.content }],
        warnings: out.warnings,
      };
    }
    case 'clipboard': {
      return {
        kind: 'text',
        files: [{ name: `${safeName}.txt`, content: buildPlainText(project) }],
        warnings: [],
      };
    }
    default:
      throw new Error(`Неизвестный формат экспорта: ${format}`);
  }
}

export const EXPORT_FORMATS = [
  { id: 'godot', label: 'Godot 4 (dialogue.json + runner + README)' },
  { id: 'renpy', label: "Ren'Py (.rpy)" },
  { id: 'markdown', label: 'Markdown (.md)' },
  { id: 'json', label: 'JSON (дамп проекта)' },
  { id: 'clipboard', label: 'Копировать текст в буфер' },
];
