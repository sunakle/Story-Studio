import { ui } from "../../shared/language";
import { useSyncExternalStore } from "react";
import { z } from "zod";
export const paletteSchema = z.object({
  type: z.literal("gigma.palette"),
  name: z.string().trim().min(1).max(60),
  colors: z
    .array(z.string().regex(/^#[a-f\d]{6}$/i))
    .min(1)
    .max(64),
});
const schema = z.object({
  theme: z.enum(["dark", "light"]).default("dark"),
  paintSlot: z.enum(["foreground", "background"]).default("foreground"),
  foreground: z
    .string()
    .regex(/^#[a-f\d]{6}$/i)
    .default("#c4b5fd"),
  background: z
    .string()
    .regex(/^#[a-f\d]{6}$/i)
    .default("#ffffff"),
  size: z.number().min(0.5).max(200).default(8),
  opacity: z.number().min(0.01).max(1).default(1),
  pressure: z.boolean().default(true),
  minimum: z.number().min(1).max(100).default(12),
  curve: z.number().min(0.25).max(3).default(1),
  smoothing: z.number().min(0).max(0.9).default(0.15),
  gridSize: z.number().int().min(2).max(128).default(16),
  snap: z.boolean().default(false),
  sides: z.number().int().min(3).max(32).default(6),
  nudge: z.number().min(0.1).max(100).default(1),
  wallpaper: z
    .string()
    .regex(/^$|^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/)
    .default(""),
  wallpaperOpacity: z.number().min(0).max(1).default(0.46),
  forest: z.boolean().default(false),
  palettes: z.array(paletteSchema).max(12).default([]),
});
type Prefs = z.infer<typeof schema>;
let current = schema.parse({});
const listeners = new Set<() => void>();
export function loadPreferences(stored: unknown) {
  const read = schema.safeParse(stored ?? {});
  if (read.success) {
    current = read.data;
    listeners.forEach((fn) => fn());
  }
}
export function preferences(patch: Partial<Prefs>) {
  current = schema.parse({ ...current, ...patch });
  listeners.forEach((fn) => fn());
  window.dispatchEvent(
    new CustomEvent("gigma-preferences", { detail: current }),
  );
}
export function usePrefs() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => current,
  );
}
export async function setWallpaper(file: File) {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size > 24 * 1024 * 1024
  )
    throw Error(
      ui(
        "Выберите PNG, JPEG или WebP до 24 МиБ.",
        "Choose a PNG, JPEG or WebP file up to 24 MiB.",
      ),
    );
  const bitmap = await createImageBitmap(file);
  try {
    const k = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height)),
      cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(bitmap.width * k));
    cv.height = Math.max(1, Math.round(bitmap.height * k));
    cv.getContext("2d")!.drawImage(bitmap, 0, 0, cv.width, cv.height);
    preferences({ wallpaper: cv.toDataURL("image/jpeg", 0.76) });
  } finally {
    bitmap.close();
  }
}
