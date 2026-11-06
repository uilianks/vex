// Writes build results to disk: SVGs, PNGs at each scale, anim strips, atlases + JSON, previews.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VexError, didYouMean, wrap } from "../core/errors.ts";
import type { Project } from "../core/project.ts";
import { type Box, innerOf } from "../core/svg.ts";
import { n } from "../core/util.ts";
import { outlineText, png, previewSvg } from "./raster.ts";
import { writeSpine } from "./spine.ts";
import { writeLevel } from "./level.ts";
import { writeFont } from "./font.ts";
import { deflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import { png as encodePng } from "../core/png.ts";
import { spriteFramesTres } from "../core/godot.ts";

/** Stretch a sprite with 9-slice margins (corners fixed, edges stretch one way, center both). */
export function nineSlice(src: Uint8Array, W: number, H: number, m: number[], outW: number, outH: number): Uint8Array {
  const [l, t, r, b] = m, out = new Uint8Array(outW * outH * 4);
  const map = (o: number, size: number, a: number, z: number, outSize: number) => {
    if (o < a) return o;
    if (o >= outSize - z) return size - (outSize - o);
    const inner = size - a - z, outInner = outSize - a - z;
    return a + Math.min(inner - 1, Math.floor(((o - a) * inner) / Math.max(1, outInner)));
  };
  for (let y = 0; y < outH; y++) {
    const sy = map(y, H, t, b, outH);
    for (let x = 0; x < outW; x++) {
      const sx = map(x, W, l, r, outW), si = (sy * W + sx) * 4, di = (y * outW + x) * 4;
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
    }
  }
  return out;
}

function ninePreview(svg: string, W: number, H: number, m: number[]): Buffer {
  const img = new Resvg(svg, { font: { loadSystemFonts: svg.includes("<text") } }).render();
  const sizes = [[W, H], [W * 2.5, H], [W * 1.5, H * 2]].map(([w, h]) => [Math.round(w), Math.round(h)]);
  const gap = 12, CW = sizes.reduce((a, [w]) => a + w + gap, gap), CH = Math.max(...sizes.map(([, h]) => h)) + gap * 2;
  const canvas = new Uint8Array(CW * CH * 4);
  for (let i = 0; i < CW * CH; i++) canvas.set([35, 32, 51, 255], i * 4);
  let x = gap;
  for (const [w, h] of sizes) {
    const part = nineSlice(img.pixels, img.width, img.height, m, w, h);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const si = (yy * w + xx) * 4, di = ((gap + yy) * CW + x + xx) * 4, a = part[si + 3] / 255;
      for (let c = 0; c < 3; c++) canvas[di + c] = Math.round(part[si + c] * a + canvas[di + c] * (1 - a));
    }
    x += w + gap;
  }
  return Buffer.from(encodePng(CW, CH, canvas, (b) => deflateSync(b)));
}

export interface OutputOptions {
  /** Only these assets/sheets (default: everything exported). */
  only?: string[];
  /** Write previews to out/_preview (default true). */
  preview?: boolean;
  /** Extra export multipliers on top of each asset's own scale (default [1]); 2 -> name@2x.png. */
  scales?: number[];
  /** Coordinate grid on previews (default true). */
  grid?: boolean;
  /** Also write a Godot 4 SpriteFrames .tres beside every anim strip and sheet (at each scale). */
  godot?: boolean;
}

export interface OutputResult {
  lines: string[];
  errors: VexError[];
}

function write(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

interface Cell {
  name: string;
  svg: string;
  box: Box;
  ms?: number;
}

interface Packed {
  svg: string;
  w: number;
  h: number;
  frames: { name: string; x: number; y: number; w: number; h: number; ms?: number }[];
}

/** Grid-pack frames into one SVG in output pixels (each cell is an exact nested document). */
export function pack(cells: Cell[], scale: number, cols?: number, pad = 0): Packed {
  const c = Math.max(1, Math.min(cells.length, cols ?? Math.ceil(Math.sqrt(cells.length))));
  const cw = Math.ceil(Math.max(...cells.map((x) => x.box.w)) * scale), ch = Math.ceil(Math.max(...cells.map((x) => x.box.h)) * scale);
  const rows = Math.ceil(cells.length / c);
  const W = c * cw + (c - 1) * pad, H = rows * ch + (rows - 1) * pad;
  let body = "";
  const frames: Packed["frames"] = [];
  cells.forEach((cell, i) => {
    const x = (i % c) * (cw + pad), y = Math.floor(i / c) * (ch + pad);
    const w = Math.ceil(cell.box.w * scale), h = Math.ceil(cell.box.h * scale);
    body += `<svg x="${x}" y="${y}" width="${n(cell.box.w * scale)}" height="${n(cell.box.h * scale)}" viewBox="${n(cell.box.x)} ${n(cell.box.y)} ${n(cell.box.w)} ${n(cell.box.h)}" overflow="hidden">${innerOf(cell.svg)}</svg>`;
    frames.push({ name: cell.name, x, y, w, h, ms: cell.ms });
  });
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`, w: W, h: H, frames };
}

/** TexturePacker/Aseprite-style hash JSON (Phaser, PixiJS, Godot importers read it). */
export function sheetJson(image: string, p: Packed, scale: number, tags: { name: string; from: number; to: number }[]): string {
  const frames: Record<string, unknown> = {};
  for (const f of p.frames)
    frames[f.name] = {
      frame: { x: f.x, y: f.y, w: f.w, h: f.h }, rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: f.w, h: f.h }, sourceSize: { w: f.w, h: f.h },
      ...(f.ms !== undefined ? { duration: f.ms } : {}),
    };
  return JSON.stringify({
    frames,
    meta: { app: "vex", version: "0.1.0", image, format: "RGBA8888", size: { w: p.w, h: p.h }, scale: String(scale), frameTags: tags.map((t) => ({ ...t, direction: "forward" })) },
  }, null, 2) + "\n";
}

const suffix = (m: number) => (m === 1 ? "" : `@${n(m)}x`);

/** Build and write. Each asset fails independently; errors are collected, not thrown. */
export function writeOutputs(p: Project, out: string, opts: OutputOptions = {}): OutputResult {
  const lines: string[] = [], errors: VexError[] = [];
  const scales = opts.scales?.length ? opts.scales : [1];
  const sheetNames = new Set(p.sheets.map((s) => s.name));
  if (opts.only)
    for (const x of opts.only)
      if (!p.assets.has(x) && !sheetNames.has(x) && !p.spines.some((sp) => sp.name === x) && !p.fonts.some((fd) => fd.name === x) && !p.levels.some((lv) => lv.name === x))
        errors.push(new VexError(`unknown asset or sheet '${x}'${didYouMean(x, [...p.order, ...sheetNames])}`));
  const want = opts.only ? new Set(opts.only) : undefined;
  if (opts.preview !== false) write(join(out, "_preview", ".gdignore"), "");   // Godot skips the previews
  const sheetOut = (base: string, json: string) => {
    write(base + ".json", json);
    if (opts.godot) write(base + ".tres", spriteFramesTres(json));
  };
  const names = want ? p.order.filter((x) => want.has(x)) : p.exported();

  for (const name of names) {
    const def = p.assets.get(name)!;
    try {
      const b = p.build(name);
      const dir = join(out, `${def.kind}s`);
      if (b.frames === 1) {
        const svg = p.svg(name, 0, 1);
        write(join(dir, name + ".svg"), outlineText(svg));
        for (const m of scales) write(join(dir, name + suffix(m) + ".png"), png(p.svg(name, 0, b.scale * m)));
        if (opts.preview !== false) write(join(out, "_preview", name + ".png"), png(previewSvg(svg, b.box, { grid: opts.grid })));
        if (def.opts.slice) {
          // 9-slice: margins in output pixels, plus a preview stretched to three sizes the way engines draw it.
          const [l, t, r, bt] = def.opts.slice.map((v) => Math.round(v * b.scale));
          const W = Math.round(b.box.w * b.scale), H = Math.round(b.box.h * b.scale);
          write(join(dir, name + ".9.json"), JSON.stringify({ image: name + ".png", width: W, height: H, slice: { left: l, top: t, right: r, bottom: bt },
            godot: { patch_margin_left: l, patch_margin_top: t, patch_margin_right: r, patch_margin_bottom: bt },
            unity: { border: [l, bt, r, t] } }, null, 2) + "\n");
          if (opts.preview !== false) write(join(out, "_preview", name + ".9.png"), ninePreview(p.svg(name, 0, b.scale), W, H, [l, t, r, bt]));
        }
        lines.push(`${def.kind} ${name} ${n(b.box.w * b.scale)}x${n(b.box.h * b.scale)}`);
      } else {
        const ms = Math.round(1000 / b.fps);
        const cells: Cell[] = Array.from({ length: b.frames }, (_, i) => {
          const svg = p.svg(name, i, 1);
          write(join(dir, name, `${i}.svg`), outlineText(svg));
          return { name: `${name}_${i}`, svg, box: p.build(name, i).box, ms };
        });
        for (const m of scales) {
          const pk = pack(cells, b.scale * m, cells.length);
          write(join(dir, name + suffix(m) + ".png"), png(pk.svg));
          sheetOut(join(dir, name + suffix(m)), sheetJson(name + suffix(m) + ".png", pk, b.scale * m, [{ name, from: 0, to: cells.length - 1 }]));
        }
        if (opts.preview !== false) {
          // All frames side by side, 1 unit gap, on one checkerboard.
          const strip = pack(cells, 1, Math.min(cells.length, 8), 1);
          write(join(out, "_preview", name + ".png"), png(previewSvg(strip.svg, { x: 0, y: 0, w: strip.w, h: strip.h }, { size: 1024, grid: opts.grid })));
        }
        lines.push(`anim ${name} ${n(b.box.w * b.scale)}x${n(b.box.h * b.scale)} (${b.frames} frames @ ${b.fps}fps)`);
      }
    } catch (e) {
      errors.push(wrap(e));
    }
  }

  for (const fd of p.fonts) {
    if (want && !want.has(fd.name)) continue;
    try { lines.push(writeFont(p, fd, out)); } catch (e) { errors.push(wrap(e).within(`font '${fd.name}'`, fd.loc)); }
  }

  for (const lv of p.levels) {
    if (want && !want.has(lv.name)) continue;
    try { lines.push(writeLevel(p, lv, out)); } catch (e) { errors.push(wrap(e).within(`level '${lv.name}'`, lv.loc)); }
  }

  for (const sp of p.spines) {
    if (want && !want.has(sp.name)) continue;
    try { lines.push(writeSpine(p, sp, out)); } catch (e) { errors.push(wrap(e).within(`spine '${sp.name}'`, sp.loc)); }
  }

  for (const s of p.sheets) {
    if (want && !want.has(s.name)) continue;
    try {
      const cells: Cell[] = [], tags: { name: string; from: number; to: number }[] = [];
      for (const name of p.sheetNames(s)) {
        const b = p.build(name);
        if (b.frames > 1) tags.push({ name, from: cells.length, to: cells.length + b.frames - 1 });
        for (let i = 0; i < b.frames; i++)
          cells.push({ name: b.frames > 1 ? `${name}_${i}` : name, svg: p.svg(name, i, 1), box: p.build(name, i).box, ms: b.frames > 1 ? Math.round(1000 / b.fps) : undefined });
      }
      if (!cells.length) throw new VexError("sheet is empty (no entries matched)");
      const base = s.opts.scale ?? 1;
      for (const m of scales) {
        const pk = pack(cells, base * m, s.opts.cols, s.opts.pad ?? 2);
        write(join(out, s.name + suffix(m) + ".png"), png(pk.svg));
        sheetOut(join(out, s.name + suffix(m)), sheetJson(s.name + suffix(m) + ".png", pk, base * m, tags));
        if (m === scales[0]) lines.push(`sheet ${s.name} ${pk.w}x${pk.h} (${cells.length} frames)`);
      }
      if (opts.preview !== false) {
        const pk = pack(cells, base, s.opts.cols, s.opts.pad ?? 2);
        write(join(out, "_preview", s.name + ".png"), png(previewSvg(pk.svg, { x: 0, y: 0, w: pk.w, h: pk.h }, { size: 1024, grid: false })));
      }
    } catch (e) {
      errors.push(wrap(e).within(`sheet '${s.name}'`, s.loc));
    }
  }
  return { lines, errors };
}
