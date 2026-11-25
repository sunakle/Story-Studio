# Приёмка StoryForge — 20 критериев §10 PROMPT-StoryForge.md

Дата: 2026-11-23. Исполнитель: QA (glm-prime). Версия проверяемой сборки: рабочее дерево на момент прогона (main.js 761 стр., app.js 1101, ai.js 1314, model.js 1722, graph.js, inspector.js, panels.js, export.js, demo/demo-project.json).

## Как воспроизвести

```powershell
# из каталога проекта
node tools/verify.mjs          # 69 PASS / 0 FAIL, exit 0
node tools/_selftest-export.mjs# все PASS, exit 0
node tools/_smoke-launch.mjs 16 --no-sandbox --user-data-dir=.userdata-prime --smoke-shot  # exit 0, пишет .logs/smoke.json
node tools/_prime-ai-e2e.mjs   # 13/13 PASS, пишет .logs/prime-ai-e2e.json (поднимает мок-сервер сам)
node tools/acceptance.mjs      # сводка 20 критериев; --smoke / --e2e перезапускают прогоны
```

Артефакты: `.logs/smoke.json`, `.logs/prime-ai-e2e.json`, `.logs/smoke.png`.

## Таблица приёмки

| № | Критерий (§10) | Вердикт | Доказательство |
|---|---|---|---|
| 1 | npm install + start, окно + демо | **PASS** | package.json main=main.js, start=`electron .`; electron 33.4.11 установлен; smoke-запуск exit 0, окно открылось, title «Ночная смена», 12 узлов, тост «Открыт демо-проект „Ночная смена"» |
| 2 | Граф: демо-дерево, рёбра, подписи, пан/зум/drag, позиции | **PASS** | smoke: рёбер 13, подписей рёбер 6, graphEmptyHidden; graph.js: wheel (750), pointerdown/pointermove (751-752), contextmenu (755), op setPositions — drag (494) и автораскладка (730) пишут позиции в проект |
| 3 | Создание узла (тулбар/контекст/«+»), связывание, удаление с перенаправлением | **PASS** | app.js:997 btnAddNode→createAfterSelected; graph.js:285 `.node-plus`; graph.js:755 контекстное меню; связывание — inspector.js:453/615 connectionsBlock; удаление — op deleteNode reconnectTo (model.js:1156; graph.js:702, inspector.js:942, ai.js:481) |
| 4 | Инспектор правит все поля всех типов | **PASS** (по коду) | все 7 типов NODE_TYPES покрыты блоками: line 287, choice 323, condition 384, scene 414, end 429, note 436, jump 443 (inspector.js); smoke: inspectorSections 5. Интерактивная правка не гонялась |
| 5 | Undo/redo: текст/создание/удаление/связи/drag/сущности/ИИ | **PASS** | verify.mjs (69 PASS): undo/redo текста, beginGroup/endGroup — N правок одна запись, applyOps откат; e2e: весь AI-ход откатывается одним Ctrl+Z (12→15→12, персонаж исчез) |
| 6 | Автосохранение + восстановление | **PASS** (по коду) | app.js:229-243 scheduleAutosave 800 мс; app.js:1048/1058 sf.autosave.read + тост «Несохранённые изменения восстановлены»; app.js:487 подсказка в настройках. Перезапуск с восстановлением интерактивно не гонялся |
| 7 | .sfproj: save/open/saveAs/recent/защита при закрытии | **PASS** (по коду) | main.js: sf:file:save/saveAs/openPath/openDialog/recent(+Add/Clear) — паритет 28↔28 с preload; main.js:193-204 диалог «В проекте есть несохранённые изменения» при закрытии; smoke: статусбар «не сохранён» |
| 8 | 6 вкладок синхронизированы | **PASS** | smoke: leftTabs 6, leftItems 12; panels.js:419-424 script/characters/locations/variables/search/stats; клики → ui.selectNode/selectEntity (441-504) |
| 9 | Поиск по всем типам, regex, подсветка, клик к объекту | **FAIL** | Типы/подсветка/клик есть: panels.js:224-252, ui.highlight, 441-504. **Regex отсутствует**: panels.js:225 `query.trim().toLowerCase()`, panels.js:234 `hay.toLowerCase().includes(q)` — подстрока; переключателя regex в UI нет (panels.js:263-265), хотя ui.highlight умеет opts.regex (app.js:75-76) |
| 10 | Статистика корректна | **PASS** | computeStats(демо): nodes=12, words=159 = Σпо главам, реплики со спикером 59 = lineWords, ΣbyType=12, minutes=2 = max(1, ceil(159/150+3с/выбор)); статусбар smoke «12 узлов • 159 слов»; verify.mjs 3 проверки computeStats PASS |
| 11 | Валидация 13 классов, без ложных на демо | **PASS** | 18 кодов в model.js (591-830); validateProject(демо): 0 ошибок / 0 предупреждений / 0 hints; smoke badge «0»; verify.mjs: 18 мутаций демо — каждый код ловится с верной severity |
| 12 | Godot: 3 файла, JSON валиден | **PASS** | buildExport(godot): README.md, dialogue.json, dialogue_runner.gd; dialogue.json парсится (start, nodes); runner — class DialogueRunner, 7682 симв.; selftest: битые ссылки помечаются, runner без подстановок `${` |
| 13 | RenPy/MD/JSON, UTF-8 | **PASS** | по 1 файлу на формат, кириллица сохраняется, json парсится; selftest: label start, Character, экранирование кавычек, menu, условия, битые ссылки помечены |
| 14 | AI: настройки/тест/стрим/tool-цикл/отмена/приглашение | **PASS** | apiKey — type=password (ai.js:1034, 1224); isConfigured + placeholder «Сначала настройте подключение выше» (ai.js:107, 1083); MAX_STEPS=25 (ai.js:22); транзакция beginGroup…finally endGroup (ai.js:863, 914-915); отмена — sf.ai.abort (ai.js:1144); e2e: «Связь есть, моделей: 1», стрим работает |
| 15 | AI реально: персонаж, 3 узла+связи, текст, ветка, валидация | **PASS** | e2e 13/13 на мок-сервере (tools/mock-ai-server.mjs, сценарий x-mock-script: e2e): create_character, bulk_apply 3 узла+2 связи (12→15), set_node_text, set_branches, validate_project; toolOk=8, toolFail=0; ключа нет — мок допускается критерием |
| 16 | Темы без перезапуска | **PASS** | e2e: dark→light по клику #btnTheme; styles.css:4/30 `:root[data-theme='dark'/'light']` |
| 17 | Хоткеи | **PASS** (по коду) | app.js:804-900: Ctrl+S/O/N/Z(+Shift)/Y/F/K/Shift+A/1..5, F5, Esc, Ctrl+D/G/Enter, Delete; гейт полей ввода (app.js:876); чат Enter/Ctrl+Enter/Shift+Enter (ai.js:1118-1130); e2e: Ctrl+Z, Enter сработали. Полный проход всех клавиш не гонялся |
| 18 | Нет ошибок в консоли | **PASS** | smoke: jsErrors []; e2e: jsErrors [], electronCrashLines []; smoke-запуск exit 0 без крэш-строк |
| 19 | 500 узлов не подвисает | **НЕ ПРОВЕРЕНО** | Модель-уровень (демо + 500 узлов, итого 512): computeStats 2 мс, validateProject 5 мс, autoLayout 0 мс, export godot 1 мс — узких мест нет. Интерактивное панорамирование в рендерере не проверялось (лимит запусков Electron) |
| 20 | Русский, склонения | **PASS** | smoke: «Ночная смена · не сохранён 12 узлов • 159 слов ✓ без проблем v1.0.0», тосты без кракозябр; plural: 1→«узел», 2→«узла», 5→«узлов»; countWords «Это предложение. Ещё одно!»=4 |

## Провалено: критерий 9 — regex в поиске

- **Что есть**: поиск по узлам (текст, заголовок, заметки, варианты, ветки), персонажам, локациям, переменным; подсветка `<mark>`; клик ведёт к объекту — panels.js:224-252, 441-504.
- **Чего нет**: regex-режима. collectMatches делает нечувствительную к регистру подстроку: panels.js:225 `const q = query.trim().toLowerCase()`, panels.js:234 `hay.toLowerCase().includes(q)`. UI поиска (panels.js:263-265) не содержит переключателя regex.
- **Примечание**: подсветка уже умеет regex — app.js:75-76 `highlight(text, query, { regex, caseSensitive })`, включая try/catch на битых паттернах. Не хватает только вызова с флагом.
- **Рекомендация**: добавить чекбокс «Regex» рядом с `#panelSearchInput`; в collectMatches при включённом флаге оборачивать запрос в `new RegExp(q, 'i')` с try/catch (как в app.js:75-79) и передавать `{ regex: true }` в ui.highlight. Объём: ~15 строк в panels.js.

## Ограничения проверки

- Критерии 4, 6, 7, 17 подтверждены статически (код + smoke-снимок), интерактивные сценарии не гонялись: правка всех полей инспектора, перезапуск с восстановлением автосохранения, цикл save/open/recent руками, полный проход всех хоткеев.
- Критерий 19: замеры только на уровне модели (импорт model.js/export.js в Node); панорамирование рендерера с 500 узлами не выполнялось.
- Критерий 15 проверен на мок-сервере — живого ключа нет; это явно допускается формулировкой критерия.
- Electron запускался ограниченно (по одному smoke/e2e за раунд, профиль `.userdata-prime`), как требовал порядок проверки.

## Итог

**ПРИЁМКА: 18/20 PASS, 1 FAIL, 1 НЕ ПРОВЕРЕНО**

FAIL — критерий 9 (regex-поиск): panels.js:225, panels.js:234, panels.js:263-265 (переключатель отсутствует); точка интеграции готова — app.js:75-76.
НЕ ПРОВЕРЕНО — критерий 19 (интерактивное панорамирование на 500 узлах); model-уровень: все операции ≤ 5 мс.

## Ревизия после исправлений (критерии 9 и 19)

По итогам приёмки провал закрыт, а непроверенный пункт догнан в окне приложения.

| № | Было | Стало | Что сделано |
|---|---|---|---|
| 9 | FAIL — regex-режим отсутствовал | **PASS** | В [panels.js](../src/js/panels.js) добавлены `makeMatcher()` (`new RegExp(q, 'i')` с try/catch), чекбокс `#panelSearchRegex` в разметке поиска и передача `{ regex: searchRegex }` в `ui.highlight`. Битый паттерн показывает «Некорректное регулярное выражение: …» вместо падения. В окне: «обычный=0, regex=4» на запросе `Полночь|склад`. |
| 19 | НЕ ПРОВЕРЕНО — только модельные замеры | **PASS** | В авто-приёмку добавлен замер в рендерере: 512 узлов — создание 500 узлов 950 мс (по одному undo-шагу на узел), полная отрисовка SVG **32 мс**, валидация **4 мс**, `fit()` **78 мс**, автосейв/панорамирование не деградируют; проект восстанавливается снапшотом. |

Фактический прогон (все артефакты свежие, профиль `.userdata`):

```
node tools/verify.mjs                -> 69 PASS / 0 FAIL / 0 SKIP
node tools/_selftest-export.mjs      -> все PASS
node tools/acceptance.mjs            -> ПРИЁМКА: 20/20 PASS, 0 FAIL, 0 НЕ ПРОВЕРЕНО
node tools/_smoke-launch.mjs 90 --no-sandbox --user-data-dir=.userdata --selftest --ai-base=http://127.0.0.1:8799/v1
                                     -> 34 проверки в окне: 34 PASS / 0 FAIL, jsErrors: []
```

Ограничения, оставшиеся в таблице выше (статически подтверждённые пункты 4, 6, 7, 17), —
это полнота интерактивного покрытия, а не дефекты: каждое поле инспектора, автоперезапуск
с восстановлением из автосейва, ручной цикл save/open/recent и полный проход хоткеев
проверены по коду и частично в окне, но не сценарием «руками».
