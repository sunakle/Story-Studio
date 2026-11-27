import { ui } from "../shared/language";
import { useRef, useState } from "react";
import { X, Upload, Trash2, SlidersHorizontal, Puzzle } from "lucide-react";
import {
  preferences,
  usePrefs,
  paletteSchema,
  setWallpaper,
} from "./core/preferences";
export const forestColors = [
  "#26352c",
  "#40533c",
  "#819269",
  "#b7ba87",
  "#b7845c",
  "#686076",
  "#799ea4",
  "#e5cfa6",
];
export function Range({
  name,
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
}: {
  name: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="range-row">
      <span>
        {name}
        <output>{Number(value.toFixed(2))}</output>
      </span>
      <input
        type="range"
        aria-label={name}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(e.target.valueAsNumber)}
      />
    </label>
  );
}
export function BrushPanel() {
  const p = usePrefs(),
    [signal, setSignal] = useState(ui("Коснитесь пером", "Touch with pen"));
  return (
    <section>
      <h3>{ui("Кисть", "Brush")}</h3>
      <div className="preset-row">
        {[
          [ui("Перо", "Pen"), 3, 1, 0.08],
          [ui("Маркер", "Marker"), 22, 0.55, 0.22],
          [ui("Тушь", "Ink"), 11, 1, 0.35],
        ].map(([name, size, opacity, smoothing]) => (
          <button
            key={name}
            onClick={() =>
              preferences({
                size: Number(size),
                opacity: Number(opacity),
                smoothing: Number(smoothing),
              })
            }
          >
            {name}
          </button>
        ))}
      </div>
      <Range
        name={ui("Диаметр, px", "Diameter, px")}
        min={0.5}
        max={200}
        step={0.5}
        value={p.size}
        onChange={(size) => preferences({ size })}
      />
      <Range
        name={ui("Непрозрачность кисти, %", "Brush opacity, %")}
        min={1}
        value={p.opacity * 100}
        onChange={(v) => preferences({ opacity: v / 100 })}
      />
      <Range
        name={ui("Сглаживание, %", "Smoothing, %")}
        max={90}
        value={p.smoothing * 100}
        onChange={(v) => preferences({ smoothing: v / 100 })}
      />
      <label className="check">
        <input
          type="checkbox"
          checked={p.pressure}
          onChange={(e) => preferences({ pressure: e.target.checked })}
        />
        {ui("Толщина от нажима пера", "Use pen pressure for width")}
      </label>
      {p.pressure && (
        <>
          <Range
            name={ui("Минимальная толщина, %", "Minimum width, %")}
            min={1}
            value={p.minimum}
            onChange={(minimum) => preferences({ minimum })}
          />
          <Range
            name={ui("Кривая нажима", "Pressure curve")}
            min={0.25}
            max={3}
            step={0.05}
            value={p.curve}
            onChange={(curve) => preferences({ curve })}
          />
        </>
      )}
      <div
        className="pen-pad"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setSignal(
            e.pointerType === "pen"
              ? ui("Перо · ", "Pen · ") + Math.round(100 * e.pressure) + "%"
              : ui("Мышь / касание", "Mouse / touch"),
          );
        }}
        onPointerMove={(e) => {
          if (e.buttons && e.pointerType === "pen")
            setSignal(
              ui("Перо · ", "Pen · ") + Math.round(100 * e.pressure) + "%",
            );
        }}
      >
        {signal}
      </div>
    </section>
  );
}
export function Settings({
  initial,
  close,
  report,
}: {
  initial: "settings" | "plugins";
  close: () => void;
  report: (e: unknown) => void;
}) {
  const p = usePrefs(),
    [tab, setTab] = useState(initial),
    image = useRef<HTMLInputElement>(null),
    extension = useRef<HTMLInputElement>(null);
  async function install(f: File) {
    if (f.size > 16000)
      throw Error(
        ui(
          "Расширение палитры должно быть меньше 16 КБ.",
          "Palette extensions must be under 16 KB.",
        ),
      );
    const data = paletteSchema.safeParse(JSON.parse(await f.text()));
    if (!data.success)
      throw Error(
        ui(
          "Нужен JSON с type: gigma.palette, названием name и массивом HEX-цветов colors.",
          "Use JSON with type: gigma.palette, a name and a colors array of hex values.",
        ),
      );
    preferences({
      palettes: [
        ...p.palettes.filter((x) => x.name !== data.data.name),
        data.data,
      ],
    });
  }
  return (
    <div className="veil">
      <div
        className="dialog settings-dialog"
        role="dialog"
        aria-label={ui("Параметры Gigma", "Gigma settings")}
      >
        <div className="dialog-head">
          <h2>{ui("Параметры Gigma", "Gigma settings")}</h2>
          <button title={ui("Закрыть", "Close")} onClick={close}>
            <X />
          </button>
        </div>
        <nav className="settings-nav">
          <button
            aria-pressed={tab === "settings"}
            onClick={() => setTab("settings")}
          >
            <SlidersHorizontal />
            {ui("Рабочая среда", "Workspace")}
          </button>
          <button
            aria-pressed={tab === "plugins"}
            onClick={() => setTab("plugins")}
          >
            <Puzzle />
            {ui("Расширения", "Extensions")}
          </button>
        </nav>
        {tab === "settings" ? (
          <>
            <h3>{ui("Обои холста", "Canvas wallpaper")}</h3>
            <div className="preset-row">
              <button onClick={() => image.current?.click()}>
                <Upload />
                {ui("Выбрать изображение", "Choose image")}
              </button>
              {p.wallpaper && (
                <button
                  title={ui("Убрать обои", "Remove wallpaper")}
                  onClick={() => preferences({ wallpaper: "" })}
                >
                  <Trash2 />
                </button>
              )}
            </div>
            {p.wallpaper && (
              <Range
                name={ui("Видимость обоев, %", "Wallpaper opacity, %")}
                value={p.wallpaperOpacity * 100}
                onChange={(v) => preferences({ wallpaperOpacity: v / 100 })}
              />
            )}
            <input
              ref={image}
              type="file"
              aria-label={ui("Файл обоев", "Wallpaper file")}
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void setWallpaper(f).catch(report);
              }}
            />
            <Range
              name={ui("Шаг сетки, px", "Grid spacing, px")}
              min={2}
              max={128}
              value={p.gridSize}
              onChange={(gridSize) => preferences({ gridSize })}
            />
            <label className="check">
              <input
                type="checkbox"
                checked={p.snap}
                onChange={(e) => preferences({ snap: e.target.checked })}
              />
              {ui(
                "Привязывать фигуры и перемещение к сетке",
                "Snap shapes and movement to grid",
              )}
            </label>
            <Range
              name={ui("Сдвиг стрелками, px", "Arrow key nudge, px")}
              min={1}
              max={50}
              value={p.nudge}
              onChange={(nudge) => preferences({ nudge })}
            />
            <Range
              name={ui("Стороны многоугольника", "Polygon sides")}
              min={3}
              max={32}
              value={p.sides}
              onChange={(sides) => preferences({ sides })}
            />
          </>
        ) : (
          <>
            <h3>{ui("Расширения палитры", "Palette extensions")}</h3>
            <label className="plugin-card">
              <span>
                <b>{ui("Лесная мастерская", "Forest workshop")}</b>
                <small>
                  {ui(
                    "8 цветов для природных материалов",
                    "8 colors for natural materials",
                  )}
                </small>
              </span>
              <input
                type="checkbox"
                checked={p.forest}
                onChange={(e) => preferences({ forest: e.target.checked })}
              />
            </label>
            {p.palettes.map((a) => (
              <div className="plugin-card" key={a.name}>
                <span>
                  {a.name}
                  <small>
                    {ui("Цветов · ", "Colors · ")}
                    {a.colors.length}
                  </small>
                </span>
                <button
                  title={ui("Удалить ", "Delete ") + a.name}
                  onClick={() =>
                    preferences({
                      palettes: p.palettes.filter((x) => x.name !== a.name),
                    })
                  }
                >
                  <Trash2 />
                </button>
              </div>
            ))}
            <button
              className="secondary"
              onClick={() => extension.current?.click()}
            >
              <Upload />
              {ui("Установить палитру из JSON", "Install palette from JSON")}
            </button>
            <input
              hidden
              ref={extension}
              type="file"
              aria-label={ui("Расширение палитры", "Palette extension")}
              accept=".json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void install(f).catch(report);
              }}
            />
            <details>
              <summary>{ui("Формат расширения", "Extension format")}</summary>
              <pre>
                {JSON.stringify(
                  {
                    type: "gigma.palette",
                    name: ui("Сумерки", "Twilight"),
                    colors: ["#9683c6", "#222336"],
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
