import { ui } from "../shared/language";
import { subscribeLanguage, getLanguage } from "../shared/language";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Circle,
  Copy,
  File,
  Frame,
  Grid2X2,
  Group,
  Hand,
  ImagePlus,
  Menu,
  Minus,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Play,
  Plus,
  Redo2,
  Save,
  Square,
  Type,
  Undo2,
  Ungroup,
  X,
} from "lucide-react";
import {
  newDocument,
  newNode,
  uid,
  validateDocument,
  type DesignNode,
} from "../shared/model";
import { Canvas, fitPage, Scene, zoomAt, type Tool } from "./Canvas";
import { Inspector, LayersPanel } from "./Panels";
import { illustratorDocument } from "./core/illustrator";
import { textLines } from "./core/text-layout";
import { Settings } from "./Settings";
import { usePrefs } from "./core/preferences";
import {
  Settings2,
  Puzzle,
  Pipette,
  Eraser,
  Hexagon,
  MousePointer,
  FileInput,
} from "lucide-react";
import {
  bindWorkspace,
  importWorkspace,
  requestSave,
  illustrator,
} from "./core/workspace";
import { studio } from "./core/studio";
import {
  descendants,
  duplicateNodes,
  groupNodes,
  inherited,
  liftNodes,
  moveNodes,
  removeNodes,
  roots,
  separateToLayer,
  ungroupNodes,
  union,
} from "./core/geometry";
import { download, exportSVG, fileName, svgPNG } from "./core/svg";

const getTools = () =>
  [
    ["select", ui("Выделение", "Select"), "V", MousePointer2],
    ["direct", ui("Прямое выделение", "Direct selection"), "D", MousePointer],
    ["frame", ui("Кадр", "Frame"), "F", Frame],
    ["rect", ui("Прямоугольник", "Rectangle"), "R", Square],
    ["ellipse", ui("Эллипс", "Ellipse"), "O", Circle],
    ["polygon", ui("Многоугольник", "Polygon"), "Y", Hexagon],
    ["line", ui("Линия", "Line"), "L", Minus],
    ["arrow", ui("Стрелка", "Arrow"), "A", MoveUpRight],
    ["path", ui("Карандаш", "Pencil"), "P", Pencil],
    ["text", ui("Текст", "Text"), "T", Type],
    ["picker", ui("Пипетка", "Eyedropper"), "I", Pipette],
    ["eraser", ui("Ластик объектов", "Object eraser"), "E", Eraser],
    ["pan", ui("Рука", "Hand"), "H", Hand],
  ] as const;
const blurField = () => {
  if (document.activeElement instanceof HTMLElement)
    document.activeElement.blur();
};
export default function App() {
  useSyncExternalStore(subscribeLanguage, getLanguage);
  const tools = getTools();
  useSyncExternalStore(studio.subscribe, studio.snapshot);
  const prefs = usePrefs();
  const [settings, setSettings] = useState<null | "settings" | "plugins">(null);
  const [tool, setTool] = useState<Tool>("select"),
    [space, setSpace] = useState(false),
    [grid, setGrid] = useState(false);
  const [menu, setMenu] = useState(false),
    [modal, setModal] = useState<"" | "export" | "keys">(""),
    [preview, setPreview] = useState<string | null>(null);
  const [format, setFormat] = useState("svg"),
    [scope, setScope] = useState("page"),
    [scale, setScale] = useState(1),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [contextSelection, setContextSelection] = useState<{
    x: number;
    y: number;
    ids: string[];
  } | null>(null);
  const importInput = useRef<HTMLInputElement>(null),
    imageInput = useRef<HTMLInputElement>(null);
  const clip = useRef<{ ids: string[]; nodes: DesignNode[] } | null>(null);
  const report = useCallback(
    (e: unknown) => setNotice(e instanceof Error ? e.message : String(e)),
    [],
  );
  const doc = studio.document,
    page = studio.page,
    sel = studio.selection;
  const contextNodes =
    contextSelection?.ids
      .map((id) => page?.nodes.find((n) => n.id === id))
      .filter((n): n is DesignNode => !!n) ?? [];
  const contextEditable =
    !!page &&
    contextNodes.length > 0 &&
    contextNodes.length === contextSelection?.ids.length &&
    contextNodes.every(
      (n) =>
        !inherited(page.nodes, n, "locked") &&
        !inherited(page.nodes, n, "hidden"),
    );
  function showContext(x: number, y: number, ids: string[]) {
    setMenu(false);
    setContextSelection({
      x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - 240)),
      y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - 116)),
      ids,
    });
  }
  function separateSelection(mode: "layer" | "up") {
    const ids = contextSelection?.ids;
    setContextSelection(null);
    if (!page || !ids?.length || !contextEditable) return;
    try {
      let chosen: string[] = [];
      studio.mutate(
        mode === "layer"
          ? ui("Отделить в новый слой", "Move to a new layer")
          : ui("Вынести из группы", "Move out of group"),
        (_, activePage) => {
          if (mode === "layer") {
            const id = separateToLayer(activePage, ids);
            chosen = id ? [id] : [];
          } else chosen = liftNodes(activePage, ids);
        },
      );
      if (chosen.length) studio.select(chosen);
    } catch (error) {
      report(error);
    }
  }
  useEffect(
    () =>
      bindWorkspace(
        (document) => {
          studio.open(document);
          setTool("select");
          setMenu(false);
          setModal("");
          setPreview(null);
          setContextSelection(null);
        },
        () => {
          blurField();
          studio.finish();
          return studio.document;
        },
        report,
      ),
    [report],
  );
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 8500);
    return () => clearTimeout(t);
  }, [notice]);
  async function importFile(f: File) {
    if (f.size > 32 * 1024 * 1024)
      throw new Error(ui("Файл больше 32 МиБ.", "The file exceeds 32 MiB."));
    const d = validateDocument(JSON.parse(await f.text()));
    d.id = uid();
    d.revision = 0;
    d.createdAt = new Date().toISOString();
    importWorkspace(d);
  }
  async function importAI(place: boolean) {
    if (busy) return;
    const target = studio.document,
      targetPage = studio.page;
    setMenu(false);
    setBusy(true);
    try {
      const file = await illustrator.open();
      if (!file) return;
      const { document: imported, warnings } = illustratorDocument(file);
      if (place) {
        if (
          !target ||
          !targetPage ||
          studio.document !== target ||
          studio.page !== targetPage
        )
          throw Error(
            ui(
              "Текущий документ изменился. Повторите размещение AI.",
              "The document changed. Place the Illustrator file again.",
            ),
          );
        const incoming = imported.pages[0].nodes;
        const wrapper = newNode("group", 0, 0, 1, 1);
        wrapper.name = imported.name;
        wrapper.artLayer = true;
        const box = union(incoming);
        if (box) Object.assign(wrapper, box);
        for (const n of incoming) if (!n.parentId) n.parentId = wrapper.id;
        const combined = {
          ...target,
          pages: target.pages.map((p) =>
            p === targetPage
              ? { ...p, nodes: [...p.nodes, wrapper, ...incoming] }
              : p,
          ),
        };
        validateDocument(combined);
        if (new Blob([JSON.stringify(combined)]).size > 31 * 1024 * 1024)
          throw Error(
            ui(
              "После размещения документ превысит 32 МиБ. Откройте AI отдельно.",
              "Placing this artwork would exceed 32 MiB. Open it in a separate workspace.",
            ),
          );
        studio.mutate(
          ui("Поместить AI со слоями", "Place layered AI artwork"),
          (_, p) => p.nodes.push(wrapper, ...incoming),
        );
        studio.select([wrapper.id]);
        fitPage(targetPage);
      } else importWorkspace(imported);
      setNotice(
        [
          ui("Открыт AI со слоями.", "Opened layered Illustrator artwork."),
          ...warnings,
        ].join(" "),
      );
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  async function importImage(f: File) {
    if (
      !page ||
      !["image/png", "image/jpeg", "image/webp"].includes(f.type) ||
      f.size > 10 * 1024 * 1024
    )
      throw new Error(
        ui(
          "Выберите PNG, JPEG или WebP до 10 МиБ.",
          "Choose a PNG, JPEG or WebP file up to 10 MiB.",
        ),
      );
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () =>
        reject(
          new Error(
            ui("Не удалось прочитать файл.", "The file could not be read."),
          ),
        );
      reader.readAsDataURL(f);
    });
    const img = new Image();
    img.src = data;
    await img.decode();
    const host = document
      .querySelector("[data-stage]")!
      .getBoundingClientRect();
    const ratio = Math.min(
        1,
        800 / Math.max(img.naturalWidth, img.naturalHeight),
      ),
      w = img.naturalWidth * ratio,
      h = img.naturalHeight * ratio;
    const n = newNode(
      "image",
      (host.width / 2 - page.view.x) / page.view.zoom - w / 2,
      (host.height / 2 - page.view.y) / page.view.zoom - h / 2,
      Math.max(w, 1),
      Math.max(h, 1),
    );
    n.image = data;
    n.name = f.name.slice(0, 200);
    studio.mutate(ui("Вставить изображение", "Insert image"), (_, p) =>
      p.nodes.push(n),
    );
    studio.select([n.id]);
    setTool("select");
  }
  function command(action: string) {
    if (!page || !doc) return;
    setMenu(false);
    if (action === "design" || action === "board") {
      const name =
        action === "board"
          ? ui("Новая доска", "New board")
          : ui("Новый дизайн", "New design");
      importWorkspace(newDocument(name, action));
      return;
    }
    if (action === "import") {
      importInput.current?.click();
      return;
    }
    if (action === "save" || action === "saveAs") {
      blurField();
      studio.finish();
      requestSave(action === "saveAs");
      return;
    }
    if (action === "keys") {
      setModal("keys");
      return;
    }
    if (action === "undo") {
      studio.undo();
      return;
    }
    if (action === "redo") {
      studio.redo();
      return;
    }
    if (action === "selectAll") {
      studio.select(
        roots(
          page.nodes,
          page.nodes
            .filter(
              (n) =>
                !inherited(page.nodes, n, "locked") &&
                !inherited(page.nodes, n, "hidden"),
            )
            .map((n) => n.id),
        ),
      );
      return;
    }
    if (action === "copy" || action === "cut") {
      if (!sel.length) return;
      const ids = roots(page.nodes, sel),
        all = descendants(page.nodes, ids);
      clip.current = {
        ids,
        nodes: structuredClone(page.nodes.filter((n) => all.has(n.id))),
      };
      if (action === "copy") return;
    }
    if ((action === "cut" || action === "delete") && sel.length) {
      studio.mutate(ui("Удалить объекты", "Delete objects"), (d, p) =>
        removeNodes(d, p, sel),
      );
      studio.select([]);
    }
    if (action === "paste" && clip.current) {
      const c = clip.current;
      const frames = new Set(
        doc.pages.flatMap((p) =>
          p.nodes.filter((n) => n.kind === "frame").map((n) => n.id),
        ),
      );
      const source = c.nodes.map((n) => ({
        ...n,
        linkTo:
          n.linkTo &&
          (frames.has(n.linkTo) || c.nodes.some((o) => o.id === n.linkTo))
            ? n.linkTo
            : null,
      }));
      studio.mutate(ui("Вставить", "Paste"), (_, p) => {
        studio.selection = duplicateNodes(p, c.ids, 24, source);
      });
    }
    if (action === "duplicate" && sel.length)
      studio.mutate(ui("Дублировать", "Duplicate"), (_, p) => {
        studio.selection = duplicateNodes(p, sel);
      });
    if (action === "group" && sel.length > 1)
      studio.mutate(ui("Сгруппировать", "Group"), (_, p) => {
        const id = groupNodes(p, sel);
        if (id) studio.selection = [id];
      });
    if (action === "ungroup" && sel.length)
      studio.mutate(ui("Разгруппировать", "Ungroup"), (_, p) => {
        studio.selection = ungroupNodes(p, sel);
      });
  }
  const frames = useMemo(
    () =>
      doc?.pages.flatMap((p) =>
        p.nodes
          .filter((n) => n.kind === "frame" && !inherited(p.nodes, n, "hidden"))
          .map((n) => ({ p, n })),
      ) ?? [],
    [doc, studio.artworkVersion],
  );
  const slide = frames.find((f) => f.n.id === preview);
  const slideIds = slide ? descendants(slide.p.nodes, [slide.n.id]) : null;
  function stepSlide(by: number) {
    if (!slide) return;
    setPreview(
      frames[(frames.indexOf(slide) + by + frames.length) % frames.length].n.id,
    );
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest(
          "input,textarea,select,[contenteditable=true]",
        ),
        ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.code === "KeyS") {
        e.preventDefault();
        command(e.shiftKey ? "saveAs" : "save");
        return;
      }
      if (settings) {
        if (e.key === "Escape") setSettings(null);
        return;
      }
      if (typing) return;
      if (contextSelection && e.key === "Escape") {
        e.preventDefault();
        setContextSelection(null);
        return;
      }
      if (e.key === "Escape") {
        setMenu(false);
        setModal("");
        setPreview(null);
        setTool("select");
        studio.select([]);
        return;
      }
      if (preview) {
        if (e.key === "ArrowRight") stepSlide(1);
        if (e.key === "ArrowLeft") stepSlide(-1);
        return;
      }
      if (modal || !page) return;
      if (ctrl) {
        const action = (
          {
            KeyZ: e.shiftKey ? "redo" : "undo",
            KeyY: "redo",
            KeyC: "copy",
            KeyV: "paste",
            KeyX: "cut",
            KeyD: "duplicate",
            KeyG: e.shiftKey ? "ungroup" : "group",
            KeyA: "selectAll",
          } as Record<string, string>
        )[e.code];
        if (action) {
          e.preventDefault();
          command(action);
        }
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        setSpace(true);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        command("delete");
        return;
      }
      if (e.code === "Digit1") {
        fitPage(page);
        return;
      }
      if (e.code === "Digit0") {
        zoomAt(page, 1);
        return;
      }
      const toolKey = tools.find((t) => "Key" + t[2] === e.code);
      if (toolKey) {
        setTool(toolKey[0]);
        return;
      }
      const delta = (
        {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        } as Record<string, number[]>
      )[e.key];
      if (delta && sel.length) {
        e.preventDefault();
        const k = (e.shiftKey ? 10 : 1) * prefs.nudge;
        studio.mutate(ui("Сдвинуть", "Nudge"), (_, p) =>
          moveNodes(p.nodes, sel, delta[0] * k, delta[1] * k),
        );
      }
    };
    const release = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpace(false);
    };
    const blur = () => setSpace(false);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", release);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", blur);
    };
  });
  async function exportFile() {
    if (!doc || !page) return;
    setBusy(true);
    try {
      const name = fileName(doc.name);
      if (format === "ai") {
        const result = await illustrator.export({
          mode: "export",
          document: {
            ...doc,
            cover: "",
            pages: doc.pages.map((p) => ({
              ...p,
              nodes: p.nodes.map((n) =>
                n.kind === "text" && n.textLayout === "wrap"
                  ? {
                      ...n,
                      text: textLines(n).join("\n"),
                      textLayout: "auto" as const,
                    }
                  : n,
              ),
            })),
          },
          selection: scope === "selection" ? sel : undefined,
        });
        download(
          new Blob([new Uint8Array(result)]),
          name + ".ai",
          "application/postscript",
        );
      } else if (format === "gigma")
        download(
          JSON.stringify({ ...doc, cover: "" }, null, 2),
          name + ".gigma",
        );
      else {
        const svg = exportSVG(
          page,
          scope === "selection" && sel.length ? sel : undefined,
        );
        if (format === "png") download(await svgPNG(svg, scale), name + ".png");
        else download(svg, name + ".svg", "image/svg+xml");
      }
      setModal("");
      setNotice(
        ui(
          "Файл подготовлен, скачивание начато.",
          "Your file is ready. Download started.",
        ),
      );
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {doc && page && (
        <div className="editor">
          <header className="toolbar">
            <div className="menu-anchor">
              <button
                className="app-menu"
                title={ui("Главное меню", "Main menu")}
                aria-label={ui("Главное меню", "Main menu")}
                onClick={() => setMenu(!menu)}
              >
                <img src="./gigma.svg" className="g-logo" alt="Gigma" />
                <ChevronDown size={12} />
              </button>
              {menu && (
                <>
                  <button
                    className="menu-back"
                    aria-label={ui("Закрыть меню", "Close menu")}
                    onClick={() => setMenu(false)}
                  />
                  <div className="dropdown">
                    <button
                      disabled={busy}
                      onClick={() => void importAI(false)}
                    >
                      <FileInput />
                      {ui("Открыть AI со слоями", "Open layered AI artwork")}
                    </button>
                    <button
                      onClick={() => {
                        setMenu(false);
                        setSettings("settings");
                      }}
                    >
                      <Settings2 />
                      {ui("Настройки", "Settings")}
                    </button>
                    <button
                      onClick={() => {
                        setMenu(false);
                        setSettings("plugins");
                      }}
                    >
                      <Puzzle />
                      {ui("Расширения", "Extensions")}
                    </button>
                    {(
                      [
                        ["design", ui("Новый дизайн", "New design"), "", File],
                        ["board", ui("Новая доска", "New board"), "", Grid2X2],
                        [
                          "import",
                          ui("Импорт .gigma…", "Import .gigma…"),
                          "",
                          FileInput,
                        ],
                        [
                          "save",
                          ui("Сохранить", "Save project"),
                          "Ctrl S",
                          Save,
                        ],
                        ["undo", ui("Отменить", "Undo"), "Ctrl Z", Undo2],
                        [
                          "redo",
                          ui("Повторить", "Redo"),
                          "Ctrl Shift Z",
                          Redo2,
                        ],
                        [
                          "duplicate",
                          ui("Дублировать", "Duplicate"),
                          "Ctrl D",
                          Copy,
                        ],
                        [
                          "group",
                          ui("Сгруппировать", "Group"),
                          "Ctrl G",
                          Group,
                        ],
                        [
                          "ungroup",
                          ui("Разгруппировать", "Ungroup"),
                          "Ctrl Shift G",
                          Ungroup,
                        ],
                        [
                          "keys",
                          ui("Горячие клавиши", "Keyboard shortcuts"),
                          "",
                          Menu,
                        ],
                      ] as const
                    ).map(([a, l, k, Icon]) => (
                      <button key={a} onClick={() => command(a)}>
                        <Icon />
                        {l}
                        <kbd>{k}</kbd>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="toolstrip" aria-label={ui("Инструменты", "Tools")}>
              {tools.map(([id, label, key, Icon]) => (
                <button
                  key={id}
                  title={label + " (" + key + ")"}
                  aria-label={label}
                  aria-pressed={tool === id}
                  className={tool === id ? "active-tool" : ""}
                  onClick={() => setTool(id)}
                >
                  <Icon />
                </button>
              ))}
              <button
                title={ui("Вставить изображение", "Insert image")}
                aria-label={ui("Вставить изображение", "Insert image")}
                onClick={() => imageInput.current?.click()}
              >
                <ImagePlus />
              </button>
              <button
                aria-label={ui("Поместить AI", "Place AI")}
                title={ui(
                  "Поместить AI со слоями в текущий документ",
                  "Place layered Illustrator artwork in this design",
                )}
                disabled={busy}
                onClick={() => void importAI(true)}
              >
                <FileInput />
              </button>
            </div>
            <button
              title={ui("Настройки рабочей среды", "Workspace settings")}
              onClick={() => setSettings("settings")}
            >
              <Settings2 size={17} />
            </button>
            <button
              title={ui("Расширения", "Extensions")}
              onClick={() => setSettings("plugins")}
            >
              <Puzzle size={17} />
            </button>
            <input
              className="doc-title"
              aria-label={ui("Название документа", "Document name")}
              key={doc.id + doc.name}
              defaultValue={doc.name}
              maxLength={200}
              onBlur={(e) => {
                const value = e.currentTarget.value.trim();
                if (value)
                  studio.mutate(
                    ui("Переименовать документ", "Rename document"),
                    (d) => {
                      d.name = value;
                    },
                  );
                else e.currentTarget.value = doc.name;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
            <div className="toolbar-end">
              <button
                title={ui("Отменить (Ctrl Z)", "Undo (Ctrl Z)")}
                disabled={!studio.undoStack.length}
                onClick={() => studio.undo()}
              >
                <Undo2 />
              </button>
              <button
                title={ui("Повторить (Ctrl Shift Z)", "Redo (Ctrl Shift Z)")}
                disabled={!studio.redoStack.length}
                onClick={() => studio.redo()}
              >
                <Redo2 />
              </button>
              <span className="divider" />
              <button
                title={ui("Просмотр прототипа", "Preview prototype")}
                aria-label={ui("Просмотр прототипа", "Preview prototype")}
                disabled={!frames.length}
                onClick={() =>
                  setPreview(
                    frames.find((f) => sel.includes(f.n.id))?.n.id ??
                      frames[0].n.id,
                  )
                }
              >
                <Play />
              </button>
              <button
                className="primary"
                onClick={() => {
                  setScope(sel.length ? "selection" : "page");
                  setModal("export");
                }}
              >
                {ui("Экспорт", "Export")}
              </button>
            </div>
          </header>
          <div className="workspace">
            <LayersPanel
              key={page.id}
              page={page}
              artworkVersion={studio.artworkVersion}
              selection={sel}
              onContextSelection={showContext}
            />
            <Canvas
              key={page.id}
              page={page}
              tool={tool}
              setTool={setTool}
              space={space}
              grid={grid}
              onContextSelection={showContext}
            />
            <Inspector page={page} brush={tool === "path"} />
          </div>
          <footer>
            {busy && !modal && (
              <span>
                {ui(
                  "Подготовка файла Illustrator…",
                  "Preparing Illustrator artwork…",
                )}
              </span>
            )}
            <span className="page-name">{page.name}</span>
            <span className="save-state" />
            <button
              title={ui("Точечная сетка", "Dot grid")}
              aria-pressed={grid}
              onClick={() => setGrid(!grid)}
            >
              <Grid2X2 />
            </button>
            <button
              title={ui("Уменьшить", "Zoom out")}
              onClick={() => zoomAt(page, page.view.zoom / 1.25)}
            >
              <Minus />
            </button>
            <button
              title={ui("Масштаб 100%", "Zoom to 100%")}
              onClick={() => zoomAt(page, 1)}
            >
              {Math.round(page.view.zoom * 100)}%
            </button>
            <button
              title={ui("Увеличить", "Zoom in")}
              onClick={() => zoomAt(page, page.view.zoom * 1.25)}
            >
              <Plus />
            </button>
            <button
              title={ui("Вписать страницу", "Fit page")}
              onClick={() => fitPage(page)}
            >
              <Frame />
            </button>
          </footer>
        </div>
      )}
      {contextSelection && (
        <>
          <div
            className="context-back"
            onPointerDown={() => setContextSelection(null)}
          />
          <div
            className="selection-context"
            role="menu"
            aria-label={ui("Действия с выделением", "Selection actions")}
            style={{ left: contextSelection.x, top: contextSelection.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <div className="selection-context-title">
              {ui("Выбрано: ", "Selected: ")}
              {contextSelection.ids.length}
            </div>
            <button
              role="menuitem"
              autoFocus
              disabled={!contextEditable}
              onClick={() => separateSelection("layer")}
            >
              <Group />
              {ui(" Отделить в новый слой", " Move to a new layer")}
            </button>
            <button
              role="menuitem"
              disabled={
                !contextEditable || !contextNodes.some((n) => n.parentId)
              }
              onClick={() => separateSelection("up")}
            >
              <Ungroup />
              {ui(" Вынести на уровень выше", " Move up one level")}
            </button>
          </div>
        </>
      )}
      <input
        hidden
        ref={importInput}
        type="file"
        accept=".gigma,application/json"
        aria-label={ui("Файл документа", "Design file")}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void importFile(f).catch(report);
        }}
      />
      <input
        hidden
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        aria-label={ui("Файл изображения", "Image file")}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void importImage(f).catch(report);
        }}
      />
      {settings && (
        <Settings
          initial={settings}
          close={() => setSettings(null)}
          report={report}
        />
      )}
      {modal && (
        <div className="veil">
          <div
            className="dialog"
            role="dialog"
            aria-label={
              modal === "keys"
                ? ui("Горячие клавиши", "Keyboard shortcuts")
                : ui("Экспорт", "Export")
            }
          >
            <div className="dialog-head">
              <h2>
                {modal === "keys"
                  ? ui("Горячие клавиши", "Keyboard shortcuts")
                  : ui("Экспорт документа", "Export design")}
              </h2>
              <button
                title={ui("Закрыть", "Close")}
                onClick={() => setModal("")}
              >
                <X />
              </button>
            </div>
            {modal === "keys" ? (
              <div className="keys">
                {[
                  [ui("Инструменты", "Tools"), "V D F R O Y L A P T I E H"],
                  [
                    ui("Переместить холст", "Pan canvas"),
                    ui("Пробел + перетаскивание", "Space + drag"),
                  ],
                  [
                    ui("Изменить масштаб", "Zoom"),
                    ui("Ctrl + колесо", "Ctrl + scroll"),
                  ],
                  [ui("Вписать / масштаб 100%", "Fit / zoom to 100%"), "1 / 0"],
                  [
                    ui("Отменить / повторить", "Undo / redo"),
                    "Ctrl Z / Ctrl Shift Z",
                  ],
                  [
                    ui(
                      "Копировать / вырезать / вставить",
                      "Copy / cut / paste",
                    ),
                    "Ctrl C / X / V",
                  ],
                  [
                    ui("Группировать / разгруппировать", "Group / ungroup"),
                    "Ctrl G / Ctrl Shift G",
                  ],
                  [ui("Сохранить на ПК", "Save project"), "Ctrl S"],
                ].map(([l, k]) => (
                  <p key={l}>
                    {l}
                    <kbd>{k}</kbd>
                  </p>
                ))}
              </div>
            ) : (
              <>
                <label className="stack">
                  {ui("Формат", "Format")}
                  <select
                    aria-label={ui("Формат экспорта", "Export format")}
                    value={format}
                    onChange={(e) => setFormat(e.target.value)}
                  >
                    <option value="svg">
                      {ui(
                        "SVG · векторное изображение",
                        "SVG · vector artwork",
                      )}
                    </option>
                    <option value="ai">
                      {ui(
                        "AI · через Illustrator для Windows",
                        "AI · Adobe Illustrator for Windows",
                      )}
                    </option>
                    <option value="png">
                      {ui("PNG · изображение", "PNG · image")}
                    </option>
                    <option value="gigma">
                      {ui(
                        "Gigma · редактируемый документ",
                        "Gigma · editable document",
                      )}
                    </option>
                  </select>
                </label>
                {format !== "gigma" && (
                  <label className="stack">
                    {ui("Область", "Scope")}
                    <select
                      value={scope}
                      onChange={(e) => setScope(e.target.value)}
                    >
                      <option value="page">
                        {ui("Вся страница", "Entire page")}
                      </option>
                      <option value="selection" disabled={!sel.length}>
                        {ui("Выбранные объекты", "Selected objects")}
                      </option>
                    </select>
                  </label>
                )}
                {format === "png" && (
                  <label className="stack">
                    {ui("Масштаб", "Scale")}
                    <select
                      value={scale}
                      onChange={(e) => setScale(Number(e.target.value))}
                    >
                      <option value={1}>1×</option>
                      <option value={2}>2×</option>
                      <option value={3}>3×</option>
                    </select>
                  </label>
                )}
                <button
                  className="primary wide"
                  disabled={busy}
                  onClick={() => void exportFile()}
                >
                  <ArrowDownToLine />
                  {busy
                    ? ui("Подготовка…", "Preparing…")
                    : ui("Скачать файл", "Download file")}
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {slide && (
        <div
          className="presentation"
          role="dialog"
          aria-label={ui("Просмотр прототипа", "Preview prototype")}
        >
          <div className="present-bar">
            <b>{slide.n.name}</b>
            <button
              onClick={() => stepSlide(-1)}
              title={ui("Предыдущий кадр", "Previous frame")}
            >
              <ArrowLeft />
            </button>
            <span>
              {frames.indexOf(slide) + 1} / {frames.length}
            </span>
            <button
              onClick={() => stepSlide(1)}
              title={ui("Следующий кадр", "Next frame")}
            >
              <ArrowRight />
            </button>
            <button
              title={ui("Закрыть просмотр", "Close preview")}
              onClick={() => setPreview(null)}
            >
              <X />
            </button>
          </div>
          <svg
            viewBox={[slide.n.x, slide.n.y, slide.n.width, slide.n.height].join(
              " ",
            )}
            style={{ aspectRatio: slide.n.width / slide.n.height }}
          >
            <Scene
              prefix="slide"
              nodes={slide.p.nodes
                .filter((n) => slideIds!.has(n.id))
                .map((n) =>
                  n.id === slide.n.id ? { ...n, parentId: null } : n,
                )}
              activate={setPreview}
            />
          </svg>
        </div>
      )}
      {notice && (
        <div role="alert" className="toast">
          {notice}
          <button title={ui("Скрыть", "Hide")} onClick={() => setNotice("")}>
            <X />
          </button>
        </div>
      )}
    </>
  );
}
