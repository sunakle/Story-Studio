import { ui } from "../../shared/language";
import {
  newDocument,
  newNode,
  validateDocument,
  type DesignNode,
  type IllustratorArtwork,
} from "../../shared/model";
import {
  allowedAttribute,
  vectorTags,
  vectorXML,
  type VectorElement,
} from "../../shared/vector";
import { union } from "./geometry";

const ns = "http://www.w3.org/2000/svg";
const auxiliary = new Set([
  "defs",
  "clipPath",
  "mask",
  "pattern",
  "symbol",
  "linearGradient",
  "radialGradient",
  "marker",
  "filter",
]);
const tagNames: Record<string, string> = {
  get PathItem() {
    return ui("Контур", "Path");
  },
  get CompoundPathItem() {
    return ui("Составной контур", "Compound path");
  },
  get RasterItem() {
    return ui("Изображение", "Image");
  },
  get PlacedItem() {
    return ui("Изображение", "Image");
  },
  get GroupItem() {
    return ui("Группа", "Group");
  },
  get TextFrame() {
    return ui("Текст в кривых", "Outlined text");
  },
  get Layer() {
    return ui("Слой", "Layer");
  },
  get SymbolItem() {
    return ui("Символ", "Symbol");
  },
};
type Meta = {
  type: string;
  name: string;
  parent: string;
  hidden: boolean;
  locked: boolean;
  rect: number[] | null;
};
function rect(raw: string) {
  const v = raw.split(",").map(Number);
  if (v.length !== 4 || !v.every(Number.isFinite))
    throw Error(
      ui(
        "Illustrator передал неверные границы объекта.",
        "Illustrator returned invalid object bounds.",
      ),
    );
  return v;
}
function readElement(el: Element, level = 0): VectorElement | null {
  if (level > 100)
    throw Error(
      ui(
        "Слишком глубокая вложенность графики Illustrator.",
        "Illustrator artwork is nested too deeply.",
      ),
    );
  if (
    el.namespaceURI !== ns ||
    ["metadata", "title", "desc"].includes(el.localName)
  )
    return null;
  if (!vectorTags.includes(el.localName))
    throw Error(
      ui(
        "Неподдерживаемый элемент Illustrator: ",
        "Unsupported Illustrator element: ",
      ) + el.localName,
    );
  const attrs: Record<string, string> = {};
  function add(k: string, value: string) {
    let v = value.trim();
    if (k === "href" && v.startsWith("data:image/")) v = v.replace(/\s/g, "");
    if (allowedAttribute(k, v)) attrs[k] = v;
    else if (
      k === "href" ||
      k === "fill" ||
      k === "filter" ||
      k === "mask" ||
      k === "clip-path"
    )
      throw Error(
        ui(
          "Неподдерживаемая ссылка или заливка Illustrator.",
          "Unsupported Illustrator reference or fill.",
        ),
      );
  }
  for (const a of el.attributes) {
    if (a.name === "style") {
      const compositing: string[] = [];
      for (const decl of a.value.split(";")) {
        const pos = decl.indexOf(":");
        if (pos < 0) continue;
        const k = decl.slice(0, pos).trim(),
          v = decl.slice(pos + 1).trim();
        if (k === "mix-blend-mode" || k === "isolation")
          compositing.push(k + ":" + v);
        else add(k, v);
      }
      if (compositing.length) add("style", compositing.join(";"));
    } else add(a.localName, a.value);
  }
  return {
    tag: el.localName,
    attrs,
    children: Array.from(el.children)
      .map((c) => readElement(c, level + 1))
      .filter((c): c is VectorElement => !!c),
  };
}
export function illustratorDocument(payload: IllustratorArtwork) {
  const doc = newDocument(payload.name.trim().slice(0, 200) || "Illustrator");
  const nodes = doc.pages[0].nodes;
  const warnings = new Set<string>();
  const meta = new Map<string, Meta>(),
    boards: { name: string; rect: number[] }[] = [];
  for (const line of payload.layers.trim().split(/\r\n?|\n/)) {
    const [kind, id, parent, type, name, hidden, locked, b] = line.split("\t");
    if (kind === "R") {
      if (Number(id) > 0)
        warnings.add(
          ui(
            "Восстановлено изображений из встроенной копии AI: ",
            "Images recovered from the embedded AI copy: ",
          ) +
            Number(id) +
            ".",
        );
      if (Number(type) > 0)
        warnings.add(
          ui(
            "Для части восстановленных изображений использована копия в разрешении экспорта Illustrator.",
            "Some images were recovered at Illustrator’s export resolution.",
          ),
        );
      if (Number(parent) > 0)
        warnings.add(
          ui("Недоступны исходники для ", "Missing sources for ") +
            Number(parent) +
            ui(
              " изображений. Их места отмечены рамкой, а слои подписаны «Нет связанного файла».",
              " images. Their positions are marked with a frame and their layers identify the missing file.",
            ),
        );
    } else if (kind === "B")
      boards.push({ name: decodeURIComponent(id), rect: rect(parent) });
    else if (kind === "N")
      meta.set(id, {
        type,
        name: decodeURIComponent(name),
        parent,
        hidden: hidden === "1",
        locked: locked === "1",
        rect: b ? rect(b) : null,
      });
  }
  if (!boards.length)
    throw Error(
      ui(
        "В файле не найдены монтажные области.",
        "No artboards were found in this file.",
      ),
    );
  const parsed = new DOMParser().parseFromString(payload.svg, "image/svg+xml");
  if (parsed.documentElement.localName !== "svg")
    throw Error(
      ui(
        "Illustrator передал повреждённую графику.",
        "Illustrator returned damaged artwork.",
      ),
    );
  const root = readElement(parsed.documentElement)!;
  const items = new Map<string, VectorElement>();
  function index(e: VectorElement) {
    if (e.attrs.id) items.set(e.attrs.id, e);
    e.children.forEach(index);
  }
  index(root);
  if (payload.pixels) {
    const full = new DOMParser().parseFromString(
      payload.pixels,
      "image/svg+xml",
    );
    if (full.documentElement.localName !== "svg")
      throw Error(
        ui(
          "Повреждена копия восстановленных изображений.",
          "The recovered image copy is damaged.",
        ),
      );
    // Illustrator can represent repeated bitmaps as local <use> references.
    function href(el: Element) {
      return (
        el.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
        el.getAttribute("href") ??
        ""
      );
    }
    for (const named of full.querySelectorAll("[id]")) {
      const id = named.getAttribute("id")!;
      if (!meta.has(id)) continue;
      let pixel: Element | null = named;
      if (pixel.localName === "use" && href(pixel).startsWith("#"))
        pixel = full.getElementById(href(pixel).slice(1));
      if (pixel?.localName !== "image") continue;
      const uri = href(pixel).replace(/\s/g, "");
      if (!uri.startsWith("data:image/") || !allowedAttribute("href", uri))
        throw Error(
          ui(
            "Неверные пиксельные данные Illustrator.",
            "Invalid Illustrator pixel data.",
          ),
        );
      let target = items.get(id);
      if (target?.tag === "use" && target.attrs.href?.startsWith("#"))
        target = items.get(target.attrs.href.slice(1));
      if (target?.tag === "image") {
        target.attrs.href = uri;
        target.attrs.preserveAspectRatio = "none";
      }
    }
  }
  // Measure only sanitized drawing primitives. The detached source XML never enters the active DOM.
  const prefix = "measure" + crypto.randomUUID() + "-";
  const scratch = document.createElementNS(ns, "svg");
  scratch.style.cssText =
    "position:fixed;left:-100000px;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none";
  scratch.setAttribute("aria-hidden", "true");
  const clean = new DOMParser().parseFromString(
    '<svg xmlns="' +
      ns +
      '" xmlns:xlink="http://www.w3.org/1999/xlink">' +
      root.children.map((e) => vectorXML(e, prefix)).join("") +
      "</svg>",
    "image/svg+xml",
  );
  for (const child of Array.from(clean.documentElement.children))
    scratch.append(document.importNode(child, true));
  document.body.append(scratch);
  try {
    const measure = (id: string) => {
      const el = scratch.getElementById(
        prefix + id,
      ) as SVGGraphicsElement | null;
      if (!el || !el.getBBox)
        throw Error(
          ui(
            "Illustrator не передал геометрию объекта ",
            "Illustrator returned no geometry for object ",
          ) + id,
        );
      const b = el.getBBox(),
        m = el.getCTM()!;
      const pts = [
        [b.x, b.y],
        [b.x + b.width, b.y],
        [b.x, b.y + b.height],
        [b.x + b.width, b.y + b.height],
      ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
      const x = Math.min(...pts.map((p) => p.x)),
        y = Math.min(...pts.map((p) => p.y));
      return {
        x,
        y,
        width: Math.max(1, Math.max(...pts.map((p) => p.x)) - x),
        height: Math.max(1, Math.max(...pts.map((p) => p.y)) - y),
      };
    };
    const origin = measure("GigmaOrigin"),
      [left, top] = boards[0].rect;
    function bounds(r: number[]) {
      return {
        x: origin.x + r[0] - left,
        y: origin.y + top - r[1],
        width: Math.max(1, r[2] - r[0]),
        height: Math.max(1, r[1] - r[3]),
      };
    }
    for (const board of boards) {
      const b = bounds(board.rect),
        n = newNode("frame", b.x, b.y, b.width, b.height);
      n.name = board.name.slice(0, 200);
      n.fill = "none";
      n.stroke = "none";
      n.clip = false;
      nodes.push(n);
    }
    const groups = new Map<string, DesignNode>(),
      seen = new Set<string>();
    function groupFor(id: string): DesignNode | undefined {
      if (!id) return;
      const existing = groups.get(id);
      if (existing) return existing;
      const m = meta.get(id);
      if (!m) return;
      const parent = groupFor(m.parent),
        n = newNode("group", 0, 0, 1, 1);
      n.name = (m.name || tagNames[m.type] || ui("Группа", "Group")).slice(
        0,
        200,
      );
      n.artLayer = m.type === "Layer";
      n.parentId = parent?.id ?? null;
      n.hidden = m.hidden;
      n.locked = m.locked;
      nodes.push(n);
      groups.set(id, n);
      return n;
    }
    function graphics(e: VectorElement): boolean {
      return (
        !auxiliary.has(e.tag) && (e.tag !== "g" || e.children.some(graphics))
      );
    }
    function dependencies(content: VectorElement) {
      const local = new Set<string>(),
        used = new Set<string>(),
        defs: VectorElement[] = [];
      function walk(v: VectorElement, fn: (v: VectorElement) => void) {
        fn(v);
        v.children.forEach((c) => walk(c, fn));
      }
      walk(content, (v) => {
        if (v.attrs.id) local.add(v.attrs.id);
      });
      function collect(v: VectorElement) {
        for (const [k, val] of Object.entries(v.attrs)) {
          const id =
            k === "href" && val.startsWith("#")
              ? val.slice(1)
              : val.match(/^url\(#([\w.:-]+)\)/)?.[1];
          if (!id || local.has(id) || used.has(id)) continue;
          const def = items.get(id);
          if (!def)
            throw Error(
              ui(
                "Не найден ресурс Illustrator: ",
                "Illustrator resource not found: ",
              ) + id,
            );
          used.add(id);
          defs.push(def);
          walk(def, collect);
        }
      }
      walk(content, collect);
      return defs.length
        ? [{ tag: "defs", attrs: {}, children: defs }, content]
        : [content];
    }
    function draw(
      e: VectorElement,
      wrappers: VectorElement[],
      parent?: DesignNode,
    ) {
      const id = e.attrs.id || "",
        m = meta.get(id);
      if (
        auxiliary.has(e.tag) ||
        id === "GigmaOrigin" ||
        id === "GigmaCalibration"
      )
        return;
      if (m) seen.add(id);
      if (!graphics(e)) {
        if (m?.type === "Layer" || m?.type === "GroupItem") groupFor(id);
        return;
      }
      const composite = !!(e.attrs.mask || e.attrs.filter || e.attrs.style);
      if (
        e.tag === "g" &&
        (!m || m.type === "Layer" || m.type === "GroupItem") &&
        !composite
      ) {
        const group = m ? groupFor(id) : undefined;
        const attrs = { ...e.attrs };
        delete attrs.id;
        if (group && attrs.opacity) {
          group.opacity = Math.max(0, Math.min(1, Number(attrs.opacity)));
          delete attrs.opacity;
        }
        const ancestors = Object.keys(attrs).length
          ? [...wrappers, { tag: "g", attrs, children: [] }]
          : wrappers;
        for (const child of e.children) draw(child, ancestors, group ?? parent);
        return;
      }
      let nParent = m ? groupFor(m.parent) : parent;
      if (m?.type === "Layer") nParent = groupFor(id);
      const boundsId = id || e.children.find((c) => c.attrs.id)?.attrs.id;
      const b = m?.rect
        ? bounds(m.rect)
        : boundsId
          ? measure(boundsId)
          : bounds(boards[0].rect);
      const n = newNode("vector", b.x, b.y, b.width, b.height);
      n.name = (
        m?.name ||
        tagNames[m?.type || ""] ||
        ui("Иллюстрация", "Illustration")
      ).slice(0, 200);
      n.parentId = nParent?.id ?? null;
      n.hidden = m?.type !== "Layer" && !!m?.hidden;
      n.locked = m?.type !== "Layer" && !!m?.locked;
      if (m?.type === "TextFrame")
        warnings.add(
          ui("Текст сохранён в кривых.", "Text was preserved as outlines."),
        );
      if (composite && e.tag === "g")
        warnings.add(
          ui(
            "Группы с масками или эффектами сохранены как цельные объекты.",
            "Groups with masks or effects were preserved as single objects.",
          ),
        );
      function mark(v: VectorElement) {
        if (v.attrs.id) {
          seen.add(v.attrs.id);
          if (v !== e && meta.get(v.attrs.id)?.hidden) v.attrs.display = "none";
        }
        v.children.forEach(mark);
      }
      mark(e);
      // Positive axis-aligned images map directly to a native image object at its original resolution.
      const matrix = e.attrs.transform
        ?.match(/^matrix\(\s*([^)]*)\)$/)?.[1]
        .trim()
        .split(/[\s,]+/)
        .map(Number) ?? [1, 0, 0, 1, 0, 0];
      if (
        e.tag === "image" &&
        m?.rect &&
        !wrappers.length &&
        (e.attrs.href?.length ?? 0) <= 15e6 &&
        /^data:image\/(png|jpeg|webp);base64,/.test(e.attrs.href || "") &&
        (!e.attrs.transform || e.attrs.transform.startsWith("matrix(")) &&
        (!e.attrs.preserveAspectRatio ||
          e.attrs.preserveAspectRatio === "none") &&
        matrix[0] > 0 &&
        matrix[3] > 0 &&
        matrix[1] === 0 &&
        matrix[2] === 0 &&
        Object.keys(e.attrs).every((a) =>
          [
            "href",
            "x",
            "y",
            "id",
            "width",
            "height",
            "overflow",
            "preserveAspectRatio",
            "transform",
            "opacity",
          ].includes(a),
        )
      ) {
        n.kind = "image";
        n.image = e.attrs.href;
        n.opacity = Number(e.attrs.opacity ?? 1);
      } else {
        // Promote solid path paint to editable Gigma properties without approximating its geometry.
        const fill = e.attrs.fill ?? "#000000",
          stroke = e.attrs.stroke ?? "none";
        const solid = (v: string) => v === "none" || /^#[a-f0-9]{6}$/i.test(v);
        const editable =
          !wrappers.length &&
          [
            "path",
            "rect",
            "ellipse",
            "circle",
            "polygon",
            "polyline",
            "line",
          ].includes(e.tag) &&
          solid(fill) &&
          solid(stroke) &&
          !composite &&
          !e.attrs["clip-path"] &&
          Number(e.attrs["stroke-width"] ?? 1) <= 200;
        let leaf = e;
        if (editable) {
          n.fill = fill;
          n.stroke = stroke;
          n.strokeWidth = Number(e.attrs["stroke-width"] ?? 1);
          n.opacity = Number(e.attrs.opacity ?? 1);
          n.fillOpacity = Number(e.attrs["fill-opacity"] ?? 1);
          const attrs = { ...e.attrs };
          for (const key of [
            "fill",
            "stroke",
            "stroke-width",
            "opacity",
            "fill-opacity",
          ])
            delete attrs[key];
          leaf = { ...e, attrs };
        }
        const wrapped = wrappers.reduceRight<VectorElement>(
          (child, w) => ({ ...w, children: [child] }),
          leaf,
        );
        n.artwork = {
          ...(editable ? { editablePaint: true } : {}),
          box: [b.x, b.y, b.width, b.height],
          elements: dependencies(wrapped),
        };
      }
      nodes.push(n);
    }
    // The SVG paint order is authoritative, including interleaved sublayers and objects.
    const rootId = root.attrs.id;
    if (rootId && meta.has(rootId))
      draw({ tag: "g", attrs: { id: rootId }, children: root.children }, []);
    else for (const child of root.children) draw(child, []);
    for (const [id, m] of meta) {
      if (m.type === "Layer" && !seen.has(id)) groupFor(id);
      else if (
        !seen.has(id) &&
        m.type !== "GroupItem" &&
        m.type !== "ClippingPath"
      )
        throw Error(
          ui(
            "Illustrator не сохранил отдельный объект «",
            "Illustrator could not save the object “",
          ) +
            (m.name || tagNames[m.type] || m.type) +
            ui("». Импорт остановлен.", "”. Import stopped."),
        );
    }
    const boxes = new Map<string, DesignNode[]>();
    for (const n of nodes)
      if (n.parentId) {
        const peers = boxes.get(n.parentId) ?? [];
        peers.push(n);
        boxes.set(n.parentId, peers);
      }
    for (const g of [...groups.values()].reverse()) {
      const box = union(boxes.get(g.id) ?? []);
      if (box) Object.assign(g, box);
    }
    if (new Blob([JSON.stringify(doc)]).size > 31 * 1024 * 1024)
      throw Error(
        ui(
          "Разобранный AI превышает лимит документа Gigma (32 МиБ).",
          "The imported AI exceeds the Gigma document limit (32 MiB).",
        ),
      );
    return { document: validateDocument(doc), warnings: [...warnings] };
  } finally {
    scratch.remove();
  }
}
