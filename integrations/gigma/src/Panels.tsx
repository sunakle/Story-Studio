import { ui } from "../shared/language";
import { subscribeLanguage, getLanguage } from "../shared/language";
import { useSyncExternalStore } from "react";
import { ColorPanel, Adjustments, LayerControls } from "./ArtPanels";
import { BrushPanel } from "./Settings";
import { imageSampling } from "./core/svg";
import { fitText, textHorizontalScale } from "./core/text-layout";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Circle,
  Diamond,
  Eye,
  EyeOff,
  File,
  Frame,
  Group,
  Image,
  Layers,
  LockKeyhole,
  Minus,
  MousePointer2,
  Pencil,
  Plus,
  Square,
  Type,
  UnlockKeyhole,
} from "lucide-react";
import {
  newNode,
  newPage,
  type DesignNode,
  type DesignPage,
} from "../shared/model";
import {
  alignNodes,
  autoLayout,
  container,
  inherited,
  moveNodes,
  reparentNode,
  reorderNode,
  resizeNodes,
  selectionBounds,
  toggleObject,
} from "./core/geometry";
import { studio } from "./core/studio";
const icons = {
  frame: Frame,
  rect: Square,
  ellipse: Circle,
  line: Minus,
  arrow: ArrowUp,
  path: Pencil,
  text: Type,
  image: Image,
  group: Group,
  polygon: Diamond,
  vector: Diamond,
};
export function Field({
  label,
  value,
  commit,
  type = "text",
  min,
  max,
}: {
  label: string;
  value: string | number;
  commit: (v: string) => void;
  type?: string;
  min?: number;
  max?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        aria-label={label}
        key={String(value)}
        type={type}
        defaultValue={value}
        min={min}
        max={max}
        maxLength={type === "text" ? 200 : undefined}
        onBlur={(e) => {
          const el = e.currentTarget;
          if (
            el.value !== String(value) &&
            el.value.trim() &&
            el.validity.valid
          )
            commit(el.value);
          else el.value = String(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.currentTarget.value = String(value);
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
export const LayersPanel = memo(function LayersPanel({
  page,
  artworkVersion,
  selection,
  onContextSelection,
}: {
  page: DesignPage;
  artworkVersion: number;
  selection: string[];
  onContextSelection: (x: number, y: number, ids: string[]) => void;
}) {
  useSyncExternalStore(subscribeLanguage, getLanguage);
  const doc = studio.document!;
  const expandedKey = `gigma:expanded:${doc.id}:${page.id}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(expandedKey);
      if (saved !== null) {
        const ids = JSON.parse(saved);
        if (Array.isArray(ids))
          return new Set(
            ids.filter((id): id is string => typeof id === "string"),
          );
      }
    } catch {
      /* Fall back to the default view. */
    }
    return new Set(
      page.nodes.filter((n) => n.kind === "frame").map((n) => n.id),
    );
  });
  function rememberExpanded(next: Set<string>) {
    setExpanded(next);
    try {
      localStorage.setItem(expandedKey, JSON.stringify([...next]));
    } catch {
      /* Keep the current view. */
    }
  }
  function toggle(id: string) {
    const next = new Set(expanded);
    if (!next.delete(id)) next.add(id);
    rememberExpanded(next);
  }
  const [filter, setFilter] = useState("all");
  const list = useRef<HTMLDivElement>(null);
  const dragging = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  useLayoutEffect(() => {
    const el = list.current!;
    const measure = () => setViewport(el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const rows = useMemo(() => {
    const children = new Map<string | null, DesignNode[]>();
    for (const n of page.nodes) {
      let peers = children.get(n.parentId);
      if (!peers) children.set(n.parentId, (peers = []));
      peers.push(n);
    }
    const ordered: {
      n: DesignNode;
      depth: number;
      has: boolean;
      closed: boolean;
    }[] = [];
    function visit(id: string | null, depth: number) {
      const peers = children.get(id);
      if (!peers) return;
      for (let i = peers.length - 1; i >= 0; i--) {
        const n = peers[i];
        if (filter !== "all" && n.kind !== filter && !container(n)) continue;
        const has = children.has(n.id),
          closed = !expanded.has(n.id);
        ordered.push({ n, depth, has, closed });
        if (has && !closed) visit(n.id, depth + 1);
      }
    }
    visit(null, 0);
    return ordered;
  }, [page, artworkVersion, filter, expanded, page.nodes.length]);
  const rowHeight = 29;
  const start = Math.max(
    0,
    Math.floor(
      Math.min(scrollTop, Math.max(0, rows.length * rowHeight - viewport)) /
        rowHeight,
    ) - 6,
  );
  const end = Math.min(
    rows.length,
    start + Math.ceil(viewport / rowHeight) + 13,
  );
  function order(dir: number) {
    const id = studio.selection[0],
      index = page.nodes.findIndex((n) => n.id === id);
    if (index < 0) return;
    const peers = page.nodes.filter(
        (n) => n.parentId === page.nodes[index].parentId,
      ),
      target = peers[peers.findIndex((n) => n.id === id) + dir];
    if (target)
      studio.mutate(ui("Порядок слоя", "Layer order"), (_, activePage) =>
        reorderNode(activePage, id, target.id, dir > 0 ? "after" : "before"),
      );
  }
  function canDrop(id: string, parentId: string | null, reorder = false) {
    const source = page.nodes.find((n) => n.id === id);
    const parent = page.nodes.find((n) => n.id === parentId);
    if (
      !source ||
      (!reorder && source.parentId === parentId) ||
      inherited(page.nodes, source, "locked") ||
      inherited(page.nodes, source, "hidden") ||
      (parentId &&
        (!parent ||
          !container(parent) ||
          inherited(page.nodes, parent, "locked") ||
          inherited(page.nodes, parent, "hidden")))
    )
      return false;
    let current = parent;
    while (current) {
      if (current.id === id) return false;
      current = page.nodes.find((n) => n.id === current?.parentId);
    }
    return true;
  }
  function placement(e: React.DragEvent<HTMLDivElement>, target: DesignNode) {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (y < 7) return "before";
    if (y > rect.height - 7) return "after";
    return container(target)
      ? "inside"
      : y < rect.height / 2
        ? "before"
        : "after";
  }
  function drop(
    parentId: string | null,
    targetId?: string,
    position?: "before" | "after" | "inside",
  ) {
    const id = dragging.current;
    dragging.current = null;
    setDropTarget(null);
    if (!id) return;
    if (targetId && position && position !== "inside") {
      if (
        !canDrop(
          id,
          page.nodes.find((n) => n.id === targetId)?.parentId ?? null,
          true,
        )
      )
        return;
      studio.mutate(ui("Порядок слоя", "Layer order"), (_, activePage) =>
        reorderNode(activePage, id, targetId, position),
      );
    } else {
      if (!canDrop(id, parentId)) return;
      studio.mutate(
        ui("Перенести в группу", "Move into group"),
        (_, activePage) => {
          reparentNode(activePage, id, parentId);
        },
      );
      if (parentId) rememberExpanded(new Set([...expanded, parentId]));
    }
    studio.select([id]);
  }
  function row({ n, depth, has, closed }: (typeof rows)[number]) {
    const Icon = icons[n.kind];
    return (
      <div
        key={n.id}
        className={
          "layer-row " +
          (selection.includes(n.id) ? "chosen " : "") +
          (n.hidden ? "dim " : "") +
          (dropTarget === n.id + ":inside" ? "drop-target " : "") +
          (dropTarget === n.id + ":before" ? "drop-before " : "") +
          (dropTarget === n.id + ":after" ? "drop-after" : "")
        }
        style={{ paddingLeft: 7 + depth * 12 }}
        onDragOver={(e) => {
          e.stopPropagation();
          const where = placement(e, n);
          const parentId = where === "inside" ? n.id : n.parentId;
          if (
            dragging.current &&
            canDrop(dragging.current, parentId, where !== "inside") &&
            dragging.current !== n.id
          ) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropTarget(n.id + ":" + where);
          }
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const where = placement(e, n);
          drop(where === "inside" ? n.id : n.parentId, n.id, where);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const ids = selection.includes(n.id) ? selection : [n.id];
          studio.select(ids);
          onContextSelection(e.clientX, e.clientY, ids);
        }}
      >
        {has ? (
          <button
            title={
              closed ? ui("Развернуть", "Expand") : ui("Свернуть", "Collapse")
            }
            onClick={() => toggle(n.id)}
          >
            {closed ? <ChevronRight /> : <ChevronDown />}
          </button>
        ) : (
          <i />
        )}
        <button
          className="layer-name"
          aria-label={ui("Выбрать слой ", "Select layer ") + n.name}
          draggable={
            !inherited(page.nodes, n, "locked") &&
            !inherited(page.nodes, n, "hidden")
          }
          onDragStart={(e) => {
            dragging.current = n.id;
            e.dataTransfer.setData("application/x-gigma-layer", n.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => {
            dragging.current = null;
            setDropTarget(null);
          }}
          onClick={(e) => {
            if (
              inherited(page.nodes, n, "locked") ||
              inherited(page.nodes, n, "hidden")
            )
              return;
            studio.select(
              e.shiftKey || e.ctrlKey || e.metaKey
                ? toggleObject(page.nodes, studio.selection, n.id)
                : [n.id],
            );
          }}
        >
          {n.kind === "image" ? (
            <img className="layer-thumb" alt="" src={n.image} />
          ) : (
            <Icon />
          )}
          {n.name}
        </button>
        <button
          title={
            n.locked
              ? ui("Разблокировать", "Unlock")
              : ui("Заблокировать", "Lock")
          }
          className={n.locked ? "" : "hover-control"}
          onClick={() => {
            studio.mutate(ui("Блокировка", "Lock layer"), () => {
              n.locked = !n.locked;
            });
            studio.select([]);
          }}
        >
          {n.locked ? <LockKeyhole /> : <UnlockKeyhole />}
        </button>
        <button
          title={n.hidden ? ui("Показать", "Show") : ui("Скрыть", "Hide")}
          className={n.hidden ? "" : "hover-control"}
          onClick={() => {
            studio.mutate(ui("Видимость", "Visibility"), () => {
              n.hidden = !n.hidden;
            });
            studio.select([]);
          }}
        >
          {n.hidden ? <EyeOff /> : <Eye />}
        </button>
      </div>
    );
  }
  return (
    <aside className="sidebar left">
      <div className="side-title">
        <span>
          <File />
          {ui(" Страницы", " Pages")}
        </span>
        <button
          title={ui("Добавить страницу", "Add page")}
          disabled={doc.pages.length >= 32}
          onClick={() => {
            studio.mutate(ui("Новая страница", "New page"), (d) => {
              const p = newPage(
                ui("Страница ", "Page ") + (d.pages.length + 1),
              );
              d.pages.push(p);
              d.activePageId = p.id;
            });
            studio.select([]);
          }}
        >
          <Plus />
        </button>
      </div>
      <div className="pages">
        {doc.pages.map((p) => (
          <button
            key={p.id}
            className={p.id === page.id ? "active-page" : ""}
            onClick={() => {
              studio.activatePage(p.id);
              studio.select([]);
            }}
          >
            <File />
            {p.name}
          </button>
        ))}
      </div>
      <div
        className={
          "side-title line " + (dropTarget === "root" ? "drop-target" : "")
        }
        onDragOver={(e) => {
          if (dragging.current && canDrop(dragging.current, null)) {
            e.preventDefault();
            setDropTarget("root");
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          drop(null);
        }}
        onDragLeave={() => setDropTarget(null)}
      >
        <span>
          <Layers />
          {ui(" Слои", " Layers")}
        </span>
        <div>
          <button
            title={ui("Новая группа", "New group")}
            onClick={() => {
              const current = page.nodes.find((n) => n.id === selection[0]);
              const group = newNode(
                "group",
                current?.x ?? 0,
                current?.y ?? 0,
                1,
                1,
              );
              group.name =
                ui("Группа ", "Group ") +
                (page.nodes.filter((n) => n.kind === "group" && !n.artLayer)
                  .length +
                  1);
              group.parentId =
                current &&
                container(current) &&
                !inherited(page.nodes, current, "locked") &&
                !inherited(page.nodes, current, "hidden")
                  ? current.id
                  : (current?.parentId ?? null);
              studio.mutate(
                ui("Создать группу", "Create group"),
                (_, activePage) => activePage.nodes.push(group),
              );
              if (group.parentId)
                rememberExpanded(new Set([...expanded, group.parentId]));
              studio.select([group.id]);
            }}
          >
            <Group />
          </button>
          <button
            title={ui("Новый слой", "New layer")}
            onClick={() => {
              const layer = newNode("group", 0, 0, 1, 1);
              layer.artLayer = true;
              layer.name =
                ui("Слой ", "Layer ") +
                (page.nodes.filter((n) => n.artLayer).length + 1);
              const current = page.nodes.find((n) =>
                studio.selection.includes(n.id),
              );
              layer.parentId =
                current?.kind === "frame"
                  ? current.id
                  : (current?.parentId ?? null);
              studio.mutate(ui("Создать слой", "Create layer"), () =>
                page.nodes.push(layer),
              );
              studio.select([layer.id]);
            }}
          >
            <Plus />
          </button>
          <button
            title={ui("Поднять слой", "Raise layer")}
            disabled={studio.selection.length !== 1}
            onClick={() => order(1)}
          >
            <ArrowUp />
          </button>
          <button
            title={ui("Опустить слой", "Lower layer")}
            disabled={studio.selection.length !== 1}
            onClick={() => order(-1)}
          >
            <ArrowDown />
          </button>
        </div>
      </div>
      <div className="layer-controls">
        <select
          aria-label={ui("Фильтр слоёв", "Filter layers")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          {Object.entries({
            all: ui("Все типы", "All types"),
            text: ui("Текст", "Text"),
            image: ui("Изображения", "Images"),
            path: ui("Кисть", "Brush"),
            vector: ui("Векторная графика", "Vector artwork"),
            rect: ui("Прямоугольники", "Rectangles"),
            ellipse: ui("Эллипсы", "Ellipses"),
            polygon: ui("Многоугольники", "Polygons"),
            frame: ui("Кадры", "Frames"),
            group: ui("Группы", "Groups"),
            arrow: ui("Стрелки", "Arrows"),
            line: ui("Линии", "Lines"),
          }).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <LayerControls
        nodes={page.nodes.filter((n) => studio.selection.includes(n.id))}
      />
      <div
        className="layers"
        ref={list}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div
          style={{
            paddingTop: start * rowHeight,
            paddingBottom: (rows.length - end) * rowHeight,
          }}
        >
          {rows.slice(start, end).map(row)}
        </div>
        {page.nodes.length === 0 && (
          <p className="muted">
            {ui(
              "Здесь появятся объекты страницы.",
              "Objects on this page will appear here.",
            )}
          </p>
        )}
      </div>
    </aside>
  );
});
const getAxes = () =>
  [
    ["left", ui("По левому краю", "Align left"), AlignHorizontalJustifyStart],
    [
      "center",
      ui("По центру по горизонтали", "Align horizontal centers"),
      AlignHorizontalJustifyCenter,
    ],
    ["right", ui("По правому краю", "Align right"), AlignHorizontalJustifyEnd],
    ["top", ui("По верхнему краю", "Align top"), AlignVerticalJustifyStart],
    [
      "middle",
      ui("По центру по вертикали", "Align vertical centers"),
      AlignVerticalJustifyCenter,
    ],
    ["bottom", ui("По нижнему краю", "Align bottom"), AlignVerticalJustifyEnd],
  ] as const;
export function Inspector({
  page,
  brush,
}: {
  page: DesignPage;
  brush: boolean;
}) {
  const [tab, setTab] = useState("design"),
    doc = studio.document!;
  const nodes = page.nodes.filter((n) => studio.selection.includes(n.id)),
    n = nodes[0],
    box = selectionBounds(page.nodes, studio.selection);
  function assign(patch: Partial<DesignNode>) {
    studio.mutate(ui("Свойства объекта", "Object properties"), () => {
      for (const o of nodes) {
        if (o.kind === "text" && "text" in patch && o.textScaleX !== undefined)
          o.textScaleX = textHorizontalScale(o);
        Object.assign(o, patch);
        if (
          o.kind === "text" &&
          ("text" in patch ||
            "fontFamily" in patch ||
            "fontSize" in patch ||
            "fontWeight" in patch)
        ) {
          o.textLayout ??= "auto";
          fitText(o);
        }
      }
    });
  }
  function geometry(key: "x" | "y" | "width" | "height", value: string) {
    if (!box) return;
    const v = Number(value);
    studio.mutate(ui("Геометрия", "Geometry"), () => {
      if (key === "x" || key === "y")
        moveNodes(
          page.nodes,
          studio.selection,
          key === "x" ? v - box.x : 0,
          key === "y" ? v - box.y : 0,
        );
      else if (nodes.length === 1 && n.kind === "frame") n[key] = v;
      else {
        if (key === "width" && nodes.length === 1 && n.kind === "text") {
          n.textLayout = "wrap";
          n.width = v;
          fitText(n);
        } else
          resizeNodes(page.nodes, studio.selection, box, { ...box, [key]: v });
      }
    });
  }
  function color(key: "fill" | "stroke", label: string) {
    return (
      <div className="paint">
        <input
          type="color"
          aria-label={label}
          value={n[key] === "none" ? "#ffffff" : n[key]}
          onChange={(e) => assign({ [key]: e.target.value })}
        />
        <input
          aria-label={label + " HEX"}
          key={n[key]}
          defaultValue={
            n[key] === "none"
              ? ui("Нет", "None")
              : n[key].slice(1).toUpperCase()
          }
          maxLength={7}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          onBlur={(e) => {
            const val = e.target.value.replace(/^#/, "");
            if (/^[a-f\d]{6}$/i.test(val)) assign({ [key]: "#" + val });
            else
              e.target.value =
                n[key] === "none"
                  ? ui("Нет", "None")
                  : n[key].slice(1).toUpperCase();
          }}
        />
        <button
          title={ui("Убрать ", "Remove ") + label.toLowerCase()}
          onClick={() => assign({ [key]: "none" })}
        >
          <Minus />
        </button>
      </div>
    );
  }
  return (
    <aside className="sidebar right">
      <div className="tabs">
        {[
          ["design", ui("Дизайн", "Design")],
          ["prototype", ui("Прототип", "Prototype")],
        ].map(([t, label]) => (
          <button
            className={t === tab ? "selected" : ""}
            key={t}
            onClick={() => setTab(t)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "design" && (
        <>
          {brush && <BrushPanel />}
          <ColorPanel nodes={nodes} />
          <Adjustments nodes={nodes} />
        </>
      )}
      {!n ? (
        <section>
          <h3>{ui("Страница", "Page")}</h3>
          <Field
            label={ui("Название страницы", "Page name")}
            value={page.name}
            commit={(v) =>
              studio.mutate(ui("Название страницы", "Page name"), () => {
                page.name = v.trim();
              })
            }
          />
          <div className="empty-inspector">
            <MousePointer2 />
            <p>
              {ui(
                "Выберите объект на холсте, чтобы изменить его свойства.",
                "Select an object on the canvas to edit its properties.",
              )}
            </p>
          </div>
        </section>
      ) : tab === ui("Прототип", "Prototype") ? (
        <section>
          <h3>{ui("Переход по щелчку", "Click interaction")}</h3>
          <label className="stack">
            {ui("Целевой кадр", "Target frame")}
            <select
              aria-label={ui("Целевой кадр", "Target frame")}
              value={n.linkTo ?? ""}
              onChange={(e) => assign({ linkTo: e.target.value || null })}
            >
              <option value="">{ui("Без перехода", "No link")}</option>
              {doc.pages.flatMap((p) =>
                p.nodes
                  .filter((o) => o.kind === "frame")
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {p.name} / {f.name}
                    </option>
                  )),
              )}
            </select>
          </label>
          <p className="muted">
            {ui(
              "Откройте просмотр ▶ и нажмите на объект, чтобы перейти к кадру.",
              "Open the preview ▶ and click the object to go to its target frame.",
            )}
          </p>
        </section>
      ) : (
        <>
          <section>
            <h3>
              {nodes.length === 1
                ? n.name
                : ui("Объектов выделено · ", "Selected objects · ") +
                  nodes.length}
            </h3>
            {nodes.length === 1 && (
              <Field
                label={ui("Имя слоя", "Layer name")}
                value={n.name}
                commit={(v) => assign({ name: v.trim() })}
              />
            )}
            <div className="align">
              {getAxes().map(([axis, label, Icon]) => (
                <button
                  key={axis}
                  title={label}
                  disabled={nodes.length < 2}
                  onClick={() =>
                    studio.mutate(ui("Выровнять", "Align"), () =>
                      alignNodes(page.nodes, studio.selection, axis),
                    )
                  }
                >
                  <Icon />
                </button>
              ))}
            </div>
            {box && (
              <div className="fields">
                {(["x", "y", "width", "height"] as const).map((key, i) => (
                  <Field
                    key={key}
                    label={["X", "Y", "W", "H"][i]}
                    type="number"
                    min={i > 1 ? 1 : -1000000}
                    max={i > 1 ? 100000 : 1000000}
                    value={Number(box[key].toFixed(2))}
                    commit={(s) => geometry(key, s)}
                  />
                ))}
              </div>
            )}
            <div className="fields">
              {nodes.every((o) => !container(o)) && (
                <Field
                  label={ui("Угол °", "Rotation °")}
                  type="number"
                  min={-360}
                  max={360}
                  value={n.rotation}
                  commit={(s) => assign({ rotation: Number(s) })}
                />
              )}
              <Field
                label={ui("Видимость %", "Opacity %")}
                type="number"
                min={0}
                max={100}
                value={Math.round(n.opacity * 100)}
                commit={(s) => assign({ opacity: Number(s) / 100 })}
              />
            </div>
          </section>
          {nodes.length === 1 && n.kind === "image" && (
            <section>
              <label className="stack">
                {ui("Отображение изображения", "Image sampling")}
                <select
                  aria-label={ui("Отображение изображения", "Image sampling")}
                  value={imageSampling(n)}
                  onChange={(e) =>
                    assign({
                      sampling: e.target.value as DesignNode["sampling"],
                    })
                  }
                >
                  <option value="pixelated">
                    {ui("Чёткие пиксели", "Sharp pixels")}
                  </option>
                  <option value="auto">{ui("Сглаживание", "Smooth")}</option>
                </select>
              </label>
            </section>
          )}
          {n.kind === "text" && (
            <section>
              <h3>{ui("Текст", "Text")}</h3>
              <textarea
                className="inspector-text"
                aria-label={ui("Содержание текста", "Text content")}
                key={n.id + n.text}
                defaultValue={n.text}
                onBlur={(e) => assign({ text: e.target.value })}
                maxLength={100000}
              />
              <label className="stack">
                {ui("Гарнитура", "Typeface")}
                <select
                  aria-label={ui("Гарнитура", "Typeface")}
                  value="Impact"
                  disabled
                >
                  <option value="Impact">Impact</option>
                </select>
              </label>
              <div className="fields">
                <Field
                  label={ui("Размер", "Size")}
                  type="number"
                  min={6}
                  max={1000}
                  value={n.fontSize}
                  commit={(s) => assign({ fontSize: Number(s) })}
                />
                <select
                  aria-label={ui("Начертание", "Font weight")}
                  value={n.fontWeight}
                  onChange={(e) =>
                    assign({
                      fontWeight: e.target.value as DesignNode["fontWeight"],
                    })
                  }
                >
                  {["400", "500", "600", "700"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </div>
              <select
                aria-label={ui("Выравнивание текста", "Text alignment")}
                value={n.textAlign}
                onChange={(e) =>
                  assign({
                    textAlign: e.target.value as DesignNode["textAlign"],
                  })
                }
              >
                <option value="left">
                  {ui("По левому краю", "Align left")}
                </option>
                <option value="center">{ui("По центру", "Center")}</option>
                <option value="right">
                  {ui("По правому краю", "Align right")}
                </option>
              </select>
            </section>
          )}
          {nodes.length === 1 && ["rect", "frame"].includes(n.kind) && (
            <section>
              <h3>{ui("Углы", "Corners")}</h3>
              <label className="stack">
                {ui("Скругление углов", "Corner rounding")}
                <input
                  aria-label={ui("Скругление углов", "Corner rounding")}
                  type="range"
                  min={0}
                  max={Math.min(n.width, n.height) / 2}
                  step="any"
                  value={Math.min(n.radius, n.width / 2, n.height / 2)}
                  onPointerDown={() =>
                    studio.begin(ui("Скругление углов", "Corner rounding"))
                  }
                  onChange={(e) => {
                    if (studio.before) {
                      n.radius = Number(e.target.value);
                      studio.emit();
                    } else assign({ radius: Number(e.target.value) });
                  }}
                  onPointerUp={() => studio.finish()}
                  onPointerCancel={() => studio.finish()}
                  onBlur={() => studio.finish()}
                />
              </label>
              <Field
                label={ui("Радиус углов", "Corner radius")}
                type="number"
                min={0}
                max={Math.min(n.width, n.height) / 2}
                value={Math.min(n.radius, n.width / 2, n.height / 2)}
                commit={(s) => assign({ radius: Number(s) })}
              />
            </section>
          )}
          {(n.artwork?.editablePaint ||
            !["line", "arrow", "path", "image", "vector", "group"].includes(
              n.kind,
            )) && (
            <section>
              <h3>{ui("Заливка", "Fill")}</h3>
              {color("fill", ui("Заливка", "Fill"))}
            </section>
          )}
          {(n.artwork?.editablePaint ||
            !["text", "image", "vector", "group"].includes(n.kind)) && (
            <section>
              <h3>{ui("Обводка", "Stroke")}</h3>
              {color("stroke", ui("Обводка", "Stroke"))}
              <Field
                label={ui("Толщина", "Width")}
                type="number"
                min={0}
                max={200}
                value={n.strokeWidth}
                commit={(s) => assign({ strokeWidth: Number(s) })}
              />
            </section>
          )}
          {nodes.length === 1 && container(n) && (
            <section>
              <h3>{ui("Компоновка", "Layout")}</h3>
              <select
                aria-label={ui("Компоновка", "Layout")}
                value={n.layout}
                onChange={(e) =>
                  studio.mutate(ui("Компоновка", "Layout"), () =>
                    autoLayout(
                      page,
                      n.id,
                      e.target.value as DesignNode["layout"],
                    ),
                  )
                }
              >
                <option value="free">{ui("Свободная", "Free")}</option>
                <option value="horizontal">
                  {ui("Горизонтально", "Horizontal")}
                </option>
                <option value="vertical">
                  {ui("Вертикально", "Vertical")}
                </option>
              </select>
              {n.layout !== "free" && (
                <>
                  <div className="fields">
                    {(["gap", "padding"] as const).map((k) => (
                      <Field
                        key={k}
                        label={
                          k === "gap"
                            ? ui("Шаг", "Gap")
                            : ui("Отступ", "Padding")
                        }
                        type="number"
                        min={0}
                        max={1000}
                        value={n[k]}
                        commit={(s) =>
                          studio.mutate(ui("Интервалы", "Spacing"), () => {
                            n[k] = Number(s);
                            autoLayout(page, n.id, n.layout);
                          })
                        }
                      />
                    ))}
                  </div>
                  <button
                    className="secondary"
                    onClick={() =>
                      studio.mutate(
                        ui("Разложить объекты", "Arrange objects"),
                        () => autoLayout(page, n.id, n.layout),
                      )
                    }
                  >
                    {ui("Разложить объекты", "Arrange objects")}
                  </button>
                </>
              )}
              {n.kind === "frame" && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={n.clip}
                    onChange={(e) => assign({ clip: e.target.checked })}
                  />
                  {ui("Обрезать содержимое", "Clip content")}
                </label>
              )}
            </section>
          )}
        </>
      )}
    </aside>
  );
}
