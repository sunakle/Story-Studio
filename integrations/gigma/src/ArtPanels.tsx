import { ui } from "../shared/language";
import { useEffect, useRef, useState } from "react";
import { paintChannel } from "./core/svg";
import {
  ArrowLeftRight,
  Sun,
  ChartNoAxesColumn,
  ChartSpline,
  Aperture,
  Flower2,
  Rainbow,
  Scale,
  Contrast,
  Thermometer,
  SlidersHorizontal,
  Grid3X3,
  FlipHorizontal2,
  Layers3,
  ScanLine,
  Blend,
  Palette,
  Trash2,
} from "lucide-react";
import type { DesignNode } from "../shared/model";
import { adjustmentNames, adjustmentKinds } from "../shared/adjustments";
import { preferences, usePrefs } from "./core/preferences";
import { forestColors, Range } from "./Settings";
import { studio } from "./core/studio";
const icons = [
  Sun,
  ChartNoAxesColumn,
  ChartSpline,
  Aperture,
  Flower2,
  Rainbow,
  Scale,
  Contrast,
  Thermometer,
  SlidersHorizontal,
  Grid3X3,
  FlipHorizontal2,
  Layers3,
  ScanLine,
  Blend,
  Palette,
];
function hsv(hex: string) {
  const [r, g, b] = [1, 3, 5].map(
    (i) => parseInt(hex.slice(i, i + 2), 16) / 255,
  );
  const v = Math.max(r, g, b),
    d = v - Math.min(r, g, b);
  return {
    h: !d
      ? 0
      : ((v === r ? (g - b) / d : v === g ? 2 + (b - r) / d : 4 + (r - g) / d) *
          60 +
          360) %
        360,
    s: v ? d / v : 0,
    v,
  };
}
function rgb(h: number, s: number, v: number) {
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))))
      .toString(16)
      .padStart(2, "0");
  };
  return "#" + channel(5) + channel(3) + channel(1);
}
export function ColorPanel({ nodes }: { nodes: DesignNode[] }) {
  const p = usePrefs(),
    slot = p.paintSlot;
  type HSV = ReturnType<typeof hsv>;
  const memory = useRef<
    Partial<Record<typeof slot, { hex: string; point: HSV }>>
  >({});
  const [preview, setPreview] = useState<HSV | null>(null);
  const drag = useRef<{
    id: number;
    surface: SVGSVGElement | null;
    point: HSV;
    raf: number | null;
  } | null>(null);
  const stored = p[slot];
  function decode(hex: string): HSV {
    const old = memory.current[slot];
    if (old?.hex === hex) return old.point;
    const point = hsv(hex);
    if (!point.s) point.h = old?.point.h ?? 0;
    if (!point.v) point.s = old?.point.s ?? 0;
    return point;
  }
  const point = preview ?? decode(stored),
    { h: hue, s, v } = point;
  const color = preview ? rgb(hue, s, v) : stored;
  function choose(value: string, next = decode(value)) {
    memory.current[slot] = { hex: value, point: next };
    if (stored !== value) preferences({ [slot]: value });
    const targets = nodes.filter((n) => {
      const key = paintChannel(n);
      return key && n[key] !== value;
    });
    if (targets.length)
      studio.mutate(ui("Цвет слоя", "Layer color"), () => {
        for (const n of targets) n[paintChannel(n)!] = value;
      });
  }
  function begin(e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0 || drag.current) return false;
    drag.current = {
      id: e.pointerId,
      surface: document.querySelector<SVGSVGElement>("svg.surface"),
      point,
      raf: null,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    return true;
  }
  function show(next: HSV) {
    const d = drag.current;
    if (!d) return;
    d.point = next;
    if (d.raf !== null) return;
    d.raf = requestAnimationFrame(() => {
      d.raf = null;
      const { h, s, v } = d.point;
      d.surface?.style.setProperty("--gigma-paint", rgb(h, s, v));
      setPreview(d.point);
    });
  }
  function end(next: HSV | null) {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.raf !== null) cancelAnimationFrame(d.raf);
    try {
      if (next) choose(rgb(next.h, next.s, next.v), next);
    } finally {
      d.surface?.style.removeProperty("--gigma-paint");
      setPreview(null);
    }
  }
  useEffect(
    () => () => {
      const d = drag.current;
      if (d) {
        if (d.raf !== null) cancelAnimationFrame(d.raf);
        d.surface?.style.removeProperty("--gigma-paint");
        drag.current = null;
      }
    },
    [],
  );
  const owns = (id: number) => drag.current?.id === id;
  function pick(e: React.PointerEvent<HTMLElement>): HSV {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      h: drag.current?.point.h ?? hue,
      s: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      v: 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }
  return (
    <details className="art-section" open>
      <summary>{ui("Цвет", "Color")}</summary>
      <div className="spectrum-row">
        <div className="chips">
          <button
            title={ui("Основной цвет", "Foreground color")}
            aria-pressed={slot === "foreground"}
            style={{ background: slot === "foreground" ? color : p.foreground }}
            onClick={() => preferences({ paintSlot: "foreground" })}
          />
          <button
            title={ui("Дополнительный цвет", "Background color")}
            aria-pressed={slot === "background"}
            style={{ background: slot === "background" ? color : p.background }}
            onClick={() => preferences({ paintSlot: "background" })}
          />
          <button
            title={ui("Поменять цвета местами", "Swap colors")}
            onClick={() =>
              preferences({
                foreground: p.background,
                background: p.foreground,
              })
            }
          >
            <ArrowLeftRight />
          </button>
        </div>
        <div
          className="spectrum"
          style={{ backgroundColor: "hsl(" + hue + " 100% 50%)" }}
          onPointerDown={(e) => {
            if (begin(e)) show(pick(e));
          }}
          onPointerMove={(e) => {
            if (owns(e.pointerId)) show(pick(e));
          }}
          onPointerUp={(e) => {
            if (owns(e.pointerId)) end(pick(e));
          }}
          onPointerCancel={(e) => {
            if (owns(e.pointerId)) end(null);
          }}
          onLostPointerCapture={(e) => {
            if (owns(e.pointerId)) end(null);
          }}
        >
          <i style={{ left: s * 100 + "%", top: (1 - v) * 100 + "%" }} />
        </div>
        <input
          className="hue"
          type="range"
          min="0"
          max="359"
          aria-label={ui("Тон палитры", "Palette hue")}
          value={Math.round(hue)}
          onPointerDown={begin}
          onChange={(e) => {
            const next = {
              ...(drag.current?.point ?? point),
              h: e.target.valueAsNumber,
            };
            if (drag.current) show(next);
            else choose(rgb(next.h, next.s, next.v), next);
          }}
          onPointerUp={(e) => {
            if (owns(e.pointerId)) end(drag.current!.point);
          }}
          onPointerCancel={(e) => {
            if (owns(e.pointerId)) end(null);
          }}
          onLostPointerCapture={(e) => {
            if (owns(e.pointerId)) end(null);
          }}
        />
      </div>
      <label className="color-value">
        <input
          type="color"
          aria-label={
            slot === "background"
              ? ui("Дополнительный цвет рисования", "Secondary drawing color")
              : ui("Цвет рисования", "Drawing color")
          }
          value={color}
          onChange={(e) => choose(e.target.value)}
        />
        {color.toUpperCase()}
      </label>
      {[
        ...(p.forest
          ? [
              {
                name: ui("Лесная мастерская", "Forest workshop"),
                colors: forestColors,
              },
            ]
          : []),
        ...p.palettes,
      ].map((a) => (
        <div key={a.name} className="swatches" aria-label={a.name}>
          {a.colors.map((c, i) => (
            <button
              key={i}
              style={{ background: c }}
              title={a.name + " " + c}
              onClick={() => choose(c)}
            />
          ))}
        </div>
      ))}
    </details>
  );
}
export function Adjustments({ nodes }: { nodes: DesignNode[] }) {
  const n = nodes[0],
    p = usePrefs();
  return (
    <details className="art-section" open>
      <summary>{ui("Коррекции", "Adjustments")}</summary>
      <div className="adjust-grid">
        {adjustmentKinds.map((kind, i) => {
          const Icon = icons[i];
          return (
            <button
              key={kind}
              title={adjustmentNames[kind]}
              aria-label={
                ui("Добавить коррекцию ", "Add adjustment ") +
                adjustmentNames[kind]
              }
              disabled={
                !n || nodes.some((n) => (n.adjustments?.length ?? 0) >= 16)
              }
              onClick={() =>
                studio.mutate(
                  ui("Добавить коррекцию", "Add adjustment"),
                  () => {
                    for (const o of nodes)
                      (o.adjustments ??= []).push({
                        kind,
                        ...(kind === "gradient"
                          ? { low: p.foreground, high: p.background }
                          : {}),
                        amount:
                          kind === "invert" || kind === "mono"
                            ? 100
                            : kind === "threshold"
                              ? 0
                              : 35,
                      });
                  },
                )
              }
            >
              <Icon />
            </button>
          );
        })}
      </div>
      {nodes.length === 1 &&
        n.adjustments?.map((a, i) => (
          <div className="adjust-value" key={i}>
            <Range
              name={adjustmentNames[a.kind]}
              min={-100}
              value={a.amount}
              onChange={(amount) =>
                studio.mutate(
                  ui("Настроить коррекцию", "Edit adjustment"),
                  () => {
                    a.amount = amount;
                  },
                )
              }
            />
            {a.kind === "brightness" && (
              <Range
                name={ui("Контраст", "Contrast")}
                min={-100}
                value={a.contrast ?? 0}
                onChange={(v) =>
                  studio.mutate(ui("Контраст", "Contrast"), () => {
                    a.contrast = v;
                  })
                }
              />
            )}
            {a.kind === "gradient" && (
              <div className="gradient-ends">
                {(["low", "high"] as const).map((k, index) => (
                  <input
                    key={k}
                    type="color"
                    aria-label={
                      index
                        ? ui("Цвет света", "Highlight color")
                        : ui("Цвет тени", "Shadow color")
                    }
                    value={a[k] ?? (index ? "#ffcf97" : "#211134")}
                    onChange={(e) =>
                      studio.mutate(
                        ui("Карта градиента", "Gradient map"),
                        () => {
                          a[k] = e.target.value;
                        },
                      )
                    }
                  />
                ))}
              </div>
            )}
            <button
              title={ui("Удалить коррекцию", "Remove adjustment")}
              onClick={() =>
                studio.mutate(
                  ui("Удалить коррекцию", "Remove adjustment"),
                  () => {
                    n.adjustments!.splice(i, 1);
                  },
                )
              }
            >
              <Trash2 />
            </button>
          </div>
        ))}
    </details>
  );
}
export function LayerControls({ nodes }: { nodes: DesignNode[] }) {
  const n = nodes[0];
  if (!n) return null;
  function set(p: Partial<DesignNode>) {
    studio.mutate(ui("Свойства слоя", "Layer properties"), () => {
      for (const o of nodes) Object.assign(o, p);
    });
  }
  return (
    <div className="layer-controls">
      <select
        aria-label={ui("Режим наложения", "Blend mode")}
        value={n.blend ?? "normal"}
        onChange={(e) => set({ blend: e.target.value as DesignNode["blend"] })}
      >
        {Object.entries({
          normal: ui("Обычный", "Normal"),
          multiply: ui("Умножение", "Multiply"),
          screen: ui("Экран", "Screen"),
          overlay: ui("Перекрытие", "Overlay"),
          darken: ui("Затемнение", "Darken"),
          lighten: ui("Осветление", "Lighten"),
          difference: ui("Разница", "Difference"),
          "soft-light": ui("Мягкий свет", "Soft light"),
        }).map(([v, name]) => (
          <option key={v} value={v}>
            {name}
          </option>
        ))}
      </select>
      <Range
        name={ui("Непрозрачность слоя, %", "Layer opacity, %")}
        value={n.opacity * 100}
        onChange={(v) => set({ opacity: v / 100 })}
      />
      <Range
        name={ui("Заливка слоя, %", "Layer fill, %")}
        value={(n.fillOpacity ?? 1) * 100}
        onChange={(v) => set({ fillOpacity: v / 100 })}
      />
    </div>
  );
}
