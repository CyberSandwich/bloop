import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Rgb = [number, number, number];

const css = readFileSync(fileURLToPath(new URL("../../public/css/base.css", import.meta.url)), "utf8");

/** A `:root` token from base.css as RGB: `#rrggbb`, or `rgba(...)` laid over `under`'s color (a fill has no color alone). */
export function token(name: string, under?: string | Rgb): Rgb {
  const value = new RegExp(`--${name}: ([^;]+);`).exec(css)?.[1]?.trim();
  if (!value) throw new Error(`no --${name} in base.css`);
  const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex) return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
  const rgba = /^rgba\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)$/.exec(value);
  if (!rgba || !under) throw new Error(`--${name} is ${value}: a translucent token needs the color under it`);
  const [r, g, b, a] = rgba.slice(1).map(Number) as [number, number, number, number];
  const base = typeof under === "string" ? token(under) : under;
  return [r, g, b].map((c, i) => c * a + (base[i] ?? 0) * (1 - a)) as Rgb;
}

export function luminance(rgb: Rgb): number {
  const [r = 0, g = 0, b = 0] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
