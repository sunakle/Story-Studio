# StoryForge — инструменты QA (офлайн, без зависимостей)

| Файл | Назначение |
|---|---|
| `verify.mjs` | Приёмочный прогон: окружение, синтаксис, DOM-каркас, интеграция, model/export/фабрики. `exit 1` при любом FAIL; ещё не созданные модули дают SKIP, а не сбой. |
| `mock-ai-server.mjs` | OpenAI-совместимая заглушка (порт 8799): `/v1/models`, `/v1/chat/completions` (SSE `stream:true`, обычный `stream:false`, сценарий `tool_calls`), аварийные ответы `?fail=401`, задержка `?delay=ms`. |
| `run-app.ps1` | Запускает Electron на N секунд, собирает stdout/stderr в лог, ищет падения (Uncaught / Failed to load / …) и печатает хвост. |
| `acceptance.mjs` | Приёмка по 20 критериям §10 спеки: статические проверки кода + артефакты `.logs/smoke.json` и `.logs/prime-ai-e2e.json` + живой импорт model/export (статистика, 500 узлов). Флаги `--smoke` / `--e2e` перезапускают прогоны. Отчёт: `acceptance.md`. |
| `acceptance.md` | Человекочитаемый отчёт приёмки: таблица 20 критериев с вердиктами и доказательствами (file:line / цитаты из артефактов). |
| `_smoke-launch.mjs` | Запуск Electron с флагами и перехватом крэш-строк (использует профиль `.userdata-prime`; `--smoke-shot` пишет `.logs/smoke.json`). |
| `_prime-ai-e2e.mjs` | E2E AI-цикла через CDP (порт 9223) на мок-сервере: подключение, стрим, tool-цикл, undo, тема. Пишет `.logs/prime-ai-e2e.json`. |
| `_selftest-export.mjs` | Самопроверка экспорта: godot/renpy/markdown/json/clipboard на корректных и повреждённых данных. |

## Запуск

Все команды — из корня проекта (`storyforge/`).

```powershell
# Полный приёмочный прогон (main-инструмент)
node tools/verify.mjs

# Мок AI-сервера (пока не остановишь Ctrl+C; логи — в stdout)
node tools/mock-ai-server.mjs            # 127.0.0.1:8799
node tools/mock-ai-server.mjs --port=8801

# Ручная проверка мока
curl.exe http://127.0.0.1:8799/v1/models
curl.exe -X POST http://127.0.0.1:8799/v1/chat/completions -H "Content-Type: application/json" -d "{\"messages\":[{\"role\":\"user\",\"content\":\"привет\"}]}"
curl.exe -X POST "http://127.0.0.1:8799/v1/chat/completions?fail=401" -H "Content-Type: application/json" -d "{}"
curl.exe -N -X POST http://127.0.0.1:8799/v1/chat/completions -H "Content-Type: application/json" -d "{\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"привет\"}]}"

# Запуск приложения на 12 секунд с перехватом логов
powershell -File tools\run-app.ps1 -Seconds 12

# Приёмка по 20 критериям §10
node tools/acceptance.mjs            # по существующим артефактам .logs/*
node tools/acceptance.mjs --smoke    # + перезапуск smoke-прогона
node tools/acceptance.mjs --e2e      # + перезапуск E2E AI (мок-сервер поднимается сам)
```

## Что проверяет verify.mjs

1. **Окружение** — node/electron, `package.json`, main.js/preload.js как CJS (`node --check` через временную `.cjs`-копию).
2. **Синтаксис** — `node --check` всех `src/js/*.js` как ESM.
3. **DOM-каркас** — все id контракта §5 есть в `index.html`; все `$('…')`/`getElementById('…')` из готовых js существуют в html.
4. **Интеграция** проверяет соответствие методов рендерера, preload и main.
5. **model.js** — countWords/plural, миграция и валидация тестовой истории (0 ошибок / 0 предупреждений), согласованность computeStats, чистота autoLayout, Store (created/undo/redo/группировка/атомарность applyOps).
6. **Валидация** — 18 кодов из 13 классов контракта §3.2: мутация копии проверочного проекта → код найден, severity совпадает.
7. **export.js** — godot 3 файла, dialogue.json парсится, битая ссылка не роняет экспорт, renpy/markdown/json/clipboard.
8. **Фабрики** — `createGraph/createInspector/createPanels/createAI/createVisualizer`: функция с ≤1 аргументом, импорт без DOM.
9. **Обзор сюжета** — секция «11»: canvas-рендер, force-directed физика, фильтры, поиск, «только достижимые», подписи от степени, `#vizRoot`/`#btnViz`, подключение действия и хоткея, пункт меню, стили.

## Замечания

- Даты и время в логах — локальные (Europe/Moscow).
- Команда пишет только в `tools/` и во временный каталог ОС (`%TEMP%\sf-cjs-*` для CJS-проверок).

## Профили: тесты рядом с открытым приложением

`main.js` берёт каталог профиля в таком порядке: `SF_USERDATA` → `--user-data-dir=...` из аргументов → `<app>/.userdata` → системный `app.getPath('userData')` → temp. Блокировка единственного экземпляра привязана к этому каталогу, поэтому авто-приёмку можно гонять, не закрывая рабочее окно:

```powershell
# свой профиль для тестов, чтобы не мешать открытому приложению
node tools/_clean-profile.mjs .userdata-test
node tools/_smoke-launch.mjs 60 --no-sandbox --user-data-dir=.userdata-test --selftest
node -e "console.log(require('./.logs/selftest.json').summary)"

# AI-цикл на заглушке (мок должен быть запущен)
node tools/_smoke-launch.mjs 120 --no-sandbox --user-data-dir=.userdata-test --selftest --ai-base=http://127.0.0.1:8799/v1

# для приёмки используйте отдельный профиль
node tools/_clean-profile.mjs .userdata-test
node tools/_smoke-launch.mjs 40 --no-sandbox --user-data-dir=.userdata-test --smoke-shot
node tools/acceptance.mjs
```


## Озвучка (порт Dialogue Voice Studio)

Движок озвучки проверяется отдельно от приложения — ему не нужен Electron:

```powershell
node tools/_selftest-voice.mjs      # 40 проверок: параметры, пресеты, DSP, рендер, WAV
```

Внутри окна озвучка проверяется разделом 10 функциональной приёмки (9 проверок):
вкладка открывается, число реплик совпадает с числом озвучиваемых узлов, смена
характера и ползунок высоты пишутся в проект, реплика рендерится в звук, WAV
реально пишется на диск через IPC (`.logs/voice-selftest.wav`), прослушивание не
падает, голос персонажа задаётся отдельно. Запускается тем же прогоном:

```powershell
node tools/_clean-profile.mjs .userdata-test
node tools/_smoke-launch.mjs 150 --no-sandbox --user-data-dir=.userdata-test --selftest
```

Таймаут прогона держите не меньше 150 с: полный сценарий идёт около 2,5 минут, и при
меньшем лимите `.logs/selftest.json` просто не успевает записаться.

## Студия голоса (полный порт плагина)

Отдельное окно поверх редактора — весь интерфейс Dialogue Voice Studio: пять вкладок,
ASCII-портрет с уровнем, волна сэмпла с обрезкой и зумом, эквалайзер с точками,
эффекты, поле реплики, экспорт «WAV · импульс / WAV · реплика / 8 вариаций»,
сохранение голоса в `.dvoice`. Открывается по `Ctrl+Shift+O`, из меню
«Вид → Студия голоса» или кнопкой во вкладке «Озвучка».

Что прогонять после правок в студии или движке:

```powershell
node tools/_selftest-voice.mjs     # 61 проверка: параметры, DSP, рендер, WAV, выделение, EQ
node tools/verify.mjs              # 99 проверок (в т.ч. секция «7б. Студия голоса»)
node tools/_clean-profile.mjs .userdata-test
node tools/_smoke-launch.mjs 150 --no-sandbox --user-data-dir=.userdata-test --selftest
                                   # 61 проверка в окне, из них 9 — студия
```

С AI-заглушкой добавляется шесть проверок ассистента (всего 67):

```powershell
node tools/mock-ai-server.mjs      # в отдельном окне, порт 8799
node tools/_smoke-launch.mjs 150 --no-sandbox --user-data-dir=.userdata-test --selftest --ai-base=http://127.0.0.1:8799/v1
```

Осторожно с таймаутом: полный прогон идёт около двух минут, при 70 с процесс убивается
до записи `.logs/selftest.json` — это выглядит как зависание. Результат всегда в
`.logs/selftest.json`, разбор — `node tools/_probe-read.mjs`.

## Тестовые данные

`tools/test-fixtures.mjs` создаёт малую историю и граф из 201 узла в памяти процесса проверки. Тесты запускаются отдельно от пользовательского профиля.

## Обзор сюжета (граф в духе Obsidian)

Команда `node tools/test-graph-drag.cjs` строит синтетический граф в отдельном
профиле Electron. Тест оттаскивает связанный узел персонажа на минимальном масштабе,
удерживает его и после отпускания измеряет длину связей вплоть до остановки раскладки.

Снимок окна обзора и проверка, что облако рисуется:

```powershell
# снимок окна после прогона пробника — в .logs/viz.png
node tools/_clean-profile.mjs .userdata-shot
node tools/_smoke-launch.mjs 90 --no-sandbox --user-data-dir=.userdata-shot --selftest --selftest-file=tools/_probe-viz-shot.mjs --selftest-shot=viz
```

`--selftest-shot[=имя]` сохраняет `capturePage()` окна в `.logs/<имя>.png` сразу после
пробника — удобно смотреть, как выглядит экран, не открывая приложение руками.

Внутри приёмки — раздел 12 (`tools/selftest-renderer.mjs`): открытие и закрытие,
размер канваса, все точки и связи, кластеры глав, «Вписать» охватывает всё облако,
точки разведены физикой, фильтр персонажей, поиск, клик по точке выбирает узел.

## Изображения узлов

Медиа живёт внутри `.sfproj` (data-URL), поэтому проверки работают офлайн и без фикстур:
картинки создаются прямо в рендерере через canvas.

- `node tools/_check-media-model.mjs` — модель: `addMedia` / `setNodeMedia` /
  `deleteMedia`, миграция, высота карточки и автораскладка с фото.
- `node tools/verify.mjs` — секция «10. Изображения узлов» (14 проверок: экспорты,
  IPC `sf:media:pick`, CSS-классы, рендер графа, блок инспектора, API `app.js`).
- `--selftest` — раздел 11 (13 проверок через реальные события: импорт файла,
  превью на карточке, миниатюры в инспекторе, сжатие 2400×1600 → 1400, переключение
  превью, удаление и возврат высоты карточки).

## Производительность

Как StoryForge держит 200–500 узлов отзывчивыми (подробности — README, раздел
«Производительность», и CONTRACT §17): точечная перерисовка карточек графа,
отсечение текста в SVG по вьюпорту и зуму, «тихие» правки инспектора без полной
пересборки панели, высота текстового поля на CSS вместо чтения `scrollHeight`.

Пробники (каждый — отдельный прогон с чистым профилем):

```powershell
node tools/_clean-profile.mjs .userdata-shot
node tools/_smoke-launch.mjs 150 --no-sandbox --user-data-dir=.userdata-shot ^
  --selftest --selftest-file=tools/_probe-perf20.mjs
```

- `_probe-perf16.mjs` — цикл набора в поле: число вызовов `inspector.render`,
  `graph.refresh`, `panels.render` и длинные задачи.
- `_probe-perf20.mjs` — цена одного нажатия в четырёх вариантах (как есть, граф
  скрыт, `content-visibility`, поле без `field-sizing`).
- `_probe-perf23.mjs` — что в SVG стоит лэйаут: текст, карточки, рёбра.
- `_probe-perf24.mjs` — зависимость лэйаута от числа текстовых узлов.
- `_probe-perf27.mjs` — отсечение по кадру классом `is-far` и LOD по зуму.
- `_probe-perf28.mjs` — честный замер набора без искусственных пауз.
- `_probe-perf30.mjs` — кадры зума, пана, перетаскивания и смены выделения при
  рабочем зуме 1 на разложенном проекте.
- `_probe-perf32.mjs` — тяжёлый проект с изображением: `store.apply`,
  `JSON.stringify` для автосохранения, `validateProject`, набор с фото.

Архивные замеры предыдущего выпуска (201 узел, после `view:layout`):
нажатие 1–2 мс, набор 20 символов — 23 мс работы и 0 длинных задач, кадр пана/зума
6–8 мс, автораскладка 126 мс, `store.apply` 2.8 мс, валидация 3.3 мс.

В постоянных проверках: `verify.mjs` — секция 12 (наличие `updateLod`,
`patchGraph`, `QUIET_PROPS`, CSS-правила, отсутствие чтения `scrollHeight`);
`--selftest` — раздел 13 (набор не пересобирает панель, `is-far`/is-small,
нет задач >100 мс, правка узла переиспользует карточку).

