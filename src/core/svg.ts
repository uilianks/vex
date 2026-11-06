// Serializes resolved nodes to SVG. The only owner of color resolution: palette keys stay keys
// through the whole build so swaps (variants, use(..., { swap })) compose, and resolve here.
import { VexError } from "./errors.ts";
import { type GlowOpts, type Grad, type Node, type Paint, type Pat, type ShapeNode, type Style, isGrad, isPat } from "./model.ts";
import { bounds, inkD, lightDir, linesD, outline, shapeSeed, toneFadeD, wobbled } from "./hand.ts";
import type { Palette } from "./palette.ts";
import { esc, n } from "./util.ts";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Sil {
  color: string;
  ow: number;
}

class Ctx {
  defs: string[] = [];
  private seen = new Map<string, string>();
  private next = 0;
  pals: Palette[];
  swaps: Record<string, string>[] = [];
  /** Sum of the enclosing boil offsets. */
  boil = 0;
  readonly prefix: string;

  constructor(pal: Palette, prefix: string) {
    this.pals = [pal];
    this.prefix = prefix;
  }

  id(): string {
    return `${this.prefix}${this.next++}`;
  }

  /** Shared def (filters): one per distinct body. */
  def(key: string, make: (id: string) => string): string {
    let id = this.seen.get(key);
    if (!id) {
      id = this.id();
      this.seen.set(key, id);
      this.defs.push(make(id));
    }
    return id;
  }

  color(c: string): string {
    let k = c;
    for (let i = this.swaps.length - 1; i >= 0; i--) k = this.swaps[i][k] ?? k;
    for (let i = this.pals.length - 1; i > 0; i--) if (this.pals[i].has(k)) return this.pals[i].resolve(k);
    return this.pals[0].resolve(k);
  }

  /** Whether a palette key is defined (in any active palette). */
  has(k: string): boolean {
    return this.pals.some((p) => p.colors.has(k));
  }

  /** The color `by` ramp steps from a key (after swaps), or undefined when it is in no ramp. */
  step(c: Paint, by: number): string | undefined {
    if (typeof c !== "string") return undefined;
    let k = c;
    for (let i = this.swaps.length - 1; i >= 0; i--) k = this.swaps[i][k] ?? k;
    for (let i = this.pals.length - 1; i >= 0; i--) {
      if (!this.pals[i].colors.has(k)) continue;
      const ramp = this.pals[i].ramps.find((r) => r.includes(k));
      if (!ramp) return undefined;
      return this.pals[i].resolve(ramp[Math.max(0, Math.min(ramp.length - 1, ramp.indexOf(k) + by))]);
    }
    return undefined;
  }
}

/** Fill/stroke attributes for a paint; 8-digit hex splits into color + opacity for portability. */
function paint(ctx: Ctx, attr: "fill" | "stroke", p: Paint): string {
  if (isGrad(p)) return ` ${attr}="url(#${gradient(ctx, p)})"`;
  if (isPat(p)) return ` ${attr}="url(#${pattern(ctx, p)})"`;
  const c = ctx.color(p);
  if (c.length === 9) return ` ${attr}="${c.slice(0, 7)}" ${attr}-opacity="${n(parseInt(c.slice(7), 16) / 255)}"`;
  return ` ${attr}="${c}"`;
}

function gradient(ctx: Ctx, g: Grad): string {
  const id = ctx.id();
  const stops = g.stops.map(([c, o]) => {
    const col = ctx.color(c);
    const op = col.length === 9 ? ` stop-opacity="${n(parseInt(col.slice(7), 16) / 255)}"` : "";
    return `<stop offset="${n(o)}" stop-color="${col === "none" ? "#000" : col.slice(0, 7)}"${col === "none" ? ' stop-opacity="0"' : op}/>`;
  }).join("");
  if (g.__grad === "lin") {
    const a = ((g.angle ?? 90) * Math.PI) / 180, dx = Math.cos(a) / 2, dy = Math.sin(a) / 2;
    ctx.defs.push(`<linearGradient id="${id}" x1="${n(0.5 - dx)}" y1="${n(0.5 - dy)}" x2="${n(0.5 + dx)}" y2="${n(0.5 + dy)}">${stops}</linearGradient>`);
  } else {
    ctx.defs.push(`<radialGradient id="${id}" cx="${n(g.cx ?? 0.5)}" cy="${n(g.cy ?? 0.5)}" r="${n(g.r ?? 0.5)}">${stops}</radialGradient>`);
  }
  return id;
}

/** A repeating asset as paint: its nodes inside an SVG pattern tile of the asset's box (user space). */
function pattern(ctx: Ctx, p: Pat): string {
  const b = p.built;
  if (!b) throw new VexError(`pattern '${p.name}' was not resolved before serializing`);
  const w = p.w ?? b.box.w, h = p.h ?? b.box.h, id = ctx.id();
  if (!(w > 0 && h > 0)) throw new VexError(`pat("${p.name}"): tile w and h must be > 0`);
  // the tile's top-left is the asset box's top-left (which an outline moves to negative coordinates)
  let inner = node(ctx, { k: "g", tf: b.box.x || b.box.y ? `translate(${n(-b.box.x)} ${n(-b.box.y)})` : undefined, pal: b.pal, children: b.nodes });
  if (p.opacity !== undefined && p.opacity < 1) inner = `<g opacity="${n(p.opacity)}">${inner}</g>`;
  const tf = [p.rot ? `rotate(${n(p.rot)})` : "", p.scale !== undefined && p.scale !== 1 ? `scale(${n(p.scale)})` : ""].filter(Boolean).join(" ");
  ctx.defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" x="${n(p.x ?? 0)}" y="${n(p.y ?? 0)}" width="${n(w)}" height="${n(h)}"${tf ? ` patternTransform="${tf}"` : ""}>${inner}</pattern>`);
  return id;
}

function filters(ctx: Ctx, s: Style): string {
  const parts: string[] = [];
  if (s.grain) {
    // Grey noise with full alpha, contrast-stretched, kept inside the shape's own alpha.
    const g = s.grain;
    const body = `<feTurbulence type="fractalNoise" baseFrequency="${n(g.freq ?? 1)}" numOctaves="${Math.max(1, Math.min(6, Math.round(g.octaves ?? 2)))}" seed="${Math.round(g.seed ?? 0)}" stitchTiles="stitch"/>` +
      `<feColorMatrix type="matrix" values="0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0 0 0 0 1"/>` +
      `<feComponentTransfer><feFuncR type="linear" slope="2" intercept="-0.5"/><feFuncG type="linear" slope="2" intercept="-0.5"/><feFuncB type="linear" slope="2" intercept="-0.5"/></feComponentTransfer>` +
      `<feComposite in2="SourceGraphic" operator="in"/>`;
    const id = ctx.def(body, (id) => `<filter id="${id}" x="0" y="0" width="100%" height="100%" filterUnits="objectBoundingBox">${body}</filter>`);
    return ` filter="url(#${id})"`;
  }
  if (s.blur) parts.push(`<feGaussianBlur in="SourceGraphic" stdDeviation="${n(s.blur)}"/>`);
  let halo = "";
  if (s.glow) {
    const g: GlowOpts = typeof s.glow === "number" ? { r: s.glow } : s.glow;
    const src = s.blur ? "b0" : "SourceGraphic";
    if (s.blur) parts[0] = parts[0].replace("/>", ' result="b0"/>');
    const tint = g.color ? `<feFlood flood-color="${ctx.color(g.color).slice(0, 7)}"/><feComposite operator="in" in2="gl" result="gl"/>` : "";
    parts.push(`<feGaussianBlur in="${src}" stdDeviation="${n(g.r / 2)}" result="gl"/>${tint}`);
    const times = Math.max(1, Math.min(4, Math.round(g.strength ?? 1)));
    halo = `<feMerge>${'<feMergeNode in="gl"/>'.repeat(times)}<feMergeNode in="${src}"/></feMerge>`;
  }
  if (!parts.length) return "";
  const body = parts.join("") + halo;
  const id = ctx.def(body, (id) => `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">${body}</filter>`);
  return ` filter="url(#${id})"`;
}

function styleAttrs(ctx: Ctx, s: Style, sil?: Sil): string {
  if (sil) {
    const filled = s.fill !== undefined && !(typeof s.fill === "string" && ctx.color(s.fill) === "none");
    const stroked = s.stroke !== undefined && !(typeof s.stroke === "string" && ctx.color(s.stroke) === "none");
    const sw = (stroked ? s.sw ?? 1 : 0) + 2 * sil.ow;
    return `${filled ? paint(ctx, "fill", sil.color) : ' fill="none"'}${paint(ctx, "stroke", sil.color)} stroke-width="${n(sw)}" stroke-linejoin="round" stroke-linecap="round"`;
  }
  let a = s.fill !== undefined ? paint(ctx, "fill", s.fill) : ' fill="none"';
  if (s.stroke !== undefined) {
    a += paint(ctx, "stroke", s.stroke) + ` stroke-width="${n(s.sw ?? 1)}"`;
    a += ` stroke-linecap="${s.cap ?? "round"}" stroke-linejoin="${s.join ?? "round"}"`;
    if (s.dash?.length) a += ` stroke-dasharray="${s.dash.map(n).join(" ")}"`;
  }
  if (s.opacity !== undefined && s.opacity < 1) a += ` opacity="${n(s.opacity)}"`;
  if (s.blend && s.blend !== "normal") a += ` style="mix-blend-mode:${s.blend}"`;
  return a + filters(ctx, s);
}

const isNone = (ctx: Ctx, p: Paint | undefined) => p === undefined || (typeof p === "string" && ctx.color(p) === "none");

/** Blur filter limited to a region in the blurred element's own coordinates. */
function blurFilter(ctx: Ctx, r: number, x: number, y: number, w: number, h: number): string {
  const body = `<feGaussianBlur stdDeviation="${n(r)}"/>`;
  return ctx.def(`${body}${n(x)},${n(y)},${n(w)},${n(h)}`, (id) =>
    `<filter id="${id}" filterUnits="userSpaceOnUse" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}">${body}</filter>`);
}

/** Paint attributes for a color that may come with its own opacity. */
function tint(ctx: Ctx, c: string | undefined, fallback: string, opacity: number): string {
  const col = c ?? fallback;
  return paint(ctx, "fill", col) + (c === undefined && opacity < 1 ? ` opacity="${n(opacity)}"` : "");
}

/**
 * A shape drawn by hand: fill (following the ink's wobble), painted shading clipped to it,
 * hatching, then the ink line on top. In silhouette mode, the fill and the ink grown by `ow`.
 */
function hand(ctx: Ctx, s: ShapeNode, sil?: Sil): string {
  const st = s.style, ink = st.ink, sh = st.shade;
  const polys = outline(s);
  const seed = shapeSeed(s, ink?.seed ?? 0, ctx.boil);
  const amp = ink ? ink.wobble ?? (ink.w ?? 2) * 0.4 : 0;
  const lines = wobbled(polys, amp, seed);
  // the body: the exact element, or the wobbled outline (every subpath closed, as SVG fills it)
  const geomD = amp ? linesD(lines.map((l) => ({ ...l, closed: true }))) : "";
  const attrs = Object.entries(s.attrs).map(([k, v]) => ` ${k}="${typeof v === "number" ? n(v) : esc(v)}"`).join("");
  // the wobbled outline is long and reused by the fill, clip and masks: define it once
  const gid = geomD ? ctx.def(`<path d="${geomD}"/>`, (id) => `<path id="${id}" d="${geomD}"/>`) : "";
  const geom = (a: string) => (gid ? `<use href="#${gid}"${a}/>` : `<${s.tag}${attrs}${a}/>`);
  const inkPath = ink ? inkD(lines, { ...ink, light: ink.light ?? sh?.light }, seed) : "";
  const filled = !isNone(ctx, st.fill), stroked = !isNone(ctx, st.stroke);

  if (sil) {
    let out = filled || stroked ? geom(styleAttrs(ctx, { ...st, ink: undefined, shade: undefined, hatch: undefined, tone: undefined, spot: undefined }, sil)) : "";
    if (inkPath) out += `<path d="${inkPath}"${paint(ctx, "fill", sil.color)}${paint(ctx, "stroke", sil.color)} stroke-width="${n(2 * sil.ow)}" stroke-linejoin="round"/>`;
    return out;
  }

  let body = filled ? geom(paint(ctx, "fill", st.fill!)) : "";
  const b = bounds(polys), size = Math.max(b.w, b.h, 1);
  if (sh || st.hatch || st.tone || st.spot) {
    const clip = ctx.id();
    ctx.defs.push(`<clipPath id="${clip}">${geom("")}</clipPath>`);
    // everything here is clipped to the shape, so its box (+1 for antialiasing) bounds all the work
    const area = `x="${n(b.x - 1)}" y="${n(b.y - 1)}" width="${n(b.w + 2)}" height="${n(b.h + 2)}"`;
    /** Mask that keeps the shape's edge band on one side: a copy shifted by d covers the rest. */
    const band = (d: number, soft: number, L = lightDir(sh?.light ?? 315)): string => {
      const id = ctx.id(), dx = L[0] * d, dy = L[1] * d, m = 3 * soft + 1;
      // blur only the part of the copy that lands on the box once shifted
      const x0 = Math.max(b.x, b.x - dx) - m, x1 = Math.min(b.x + b.w, b.x + b.w - dx) + m;
      const y0 = Math.max(b.y, b.y - dy) - m, y1 = Math.min(b.y + b.h, b.y + b.h - dy) + m;
      const cover = x1 > x0 && y1 > y0
        ? `<g transform="translate(${n(dx)} ${n(dy)})"><g filter="url(#${blurFilter(ctx, soft, x0, y0, x1 - x0, y1 - y0)})">${geom(' fill="#000"')}</g></g>`
        : "";
      ctx.defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" ${area}><rect ${area} fill="#fff"/>${cover}</mask>`);
      return id;
    };
    let inner = "", shadowMask = "";
    if (sh) {
      const depth = (sh.depth ?? 0.35) * size, soft = (sh.soft ?? 0.1) * size;
      shadowMask = band(depth, soft);
      inner += `<rect ${area}${tint(ctx, sh.c ?? ctx.step(st.fill!, -2), "#1a1030", 0.5)} mask="url(#${shadowMask})"/>`;
      if (sh.hi !== false) {
        const hi = band(-depth * 0.45, soft * 0.6);
        const c = typeof sh.hi === "string" ? sh.hi : ctx.step(st.fill!, 1);
        inner += `<g opacity="0.75"><rect ${area}${tint(ctx, c, "#ffffff", 0.4)} mask="url(#${hi})"/></g>`;
      }
    }
    if (st.hatch) {
      const h = st.hatch, gap = h.gap ?? 4, pid = ctx.id();
      const lineW = n(h.w ?? 1), col = paint(ctx, "fill", h.c);
      const cross = h.cross ? `<rect x="0" y="0" width="${n(gap)}" height="${lineW}"${col}/>` : "";
      ctx.defs.push(`<pattern id="${pid}" width="${n(gap)}" height="${n(gap)}" patternUnits="userSpaceOnUse" patternTransform="rotate(${n(90 + (h.angle ?? 45))})">` +
        `<rect x="0" y="0" width="${lineW}" height="${n(gap)}"${col}/>${cross}</pattern>`);
      inner += `<rect ${area} fill="url(#${pid})" opacity="${n(h.opacity ?? 0.5)}"${shadowMask ? ` mask="url(#${shadowMask})"` : ""}/>`;
    }
    if (st.tone) {
      // screentone: a pattern of dots on the screen angle, or (fade) dots shrinking across the shape
      const t = st.tone, gap = t.gap ?? 4, col = paint(ctx, "fill", t.c), op = ` opacity="${n(t.opacity ?? 1)}"`;
      const mask = shadowMask ? ` mask="url(#${shadowMask})"` : "";
      if (t.fade !== undefined) inner += `<path d="${toneFadeD(b, t)}"${col}${op}${mask}/>`;
      else {
        const pid = ctx.id();
        ctx.defs.push(`<pattern id="${pid}" width="${n(gap)}" height="${n(gap)}" patternUnits="userSpaceOnUse" patternTransform="rotate(${n(t.angle ?? 45)})">` +
          `<circle cx="${n(gap / 2)}" cy="${n(gap / 2)}" r="${n(((t.dot ?? 0.55) * gap) / 2)}"${col}/></pattern>`);
        inner += `<rect ${area} fill="url(#${pid})"${op}${mask}/>`;
      }
    }
    if (st.spot) {
      // spot black: the far side filled solid, with a crisp edge (comic inking, not painted shading)
      // depth is measured across the shape along the light, so tall and wide shapes read the same
      const sp = st.spot, SL = lightDir(sp.light ?? sh?.light ?? 315), d = (sp.depth ?? 0.3) * (Math.abs(SL[0]) * b.w + Math.abs(SL[1]) * b.h);
      const c = sp.c ?? (ctx.has("k") ? "k" : "#000000");
      inner += `<rect ${area}${paint(ctx, "fill", c)} mask="url(#${band(d, 0.35, SL)})"/>`;
    }
    if (sh?.rim) inner += `<rect ${area}${paint(ctx, "fill", sh.rim)} mask="url(#${band(size * 0.05, size * 0.015)})"/>`;
    body += `<g clip-path="url(#${clip})">${inner}</g>`;
  }
  if (sh && (sh.brush ?? 0.5) > 0 && filled) body = `<g filter="url(#${brushFilter(ctx, sh.brush ?? 0.5, seed % 1000)})">${body}</g>`;
  if (stroked) body += geom(` fill="none"` + paint(ctx, "stroke", st.stroke!) + ` stroke-width="${n(st.sw ?? 1)}" stroke-linecap="${st.cap ?? "round"}" stroke-linejoin="${st.join ?? "round"}"`);
  if (inkPath) body += `<path d="${inkPath}"${paint(ctx, "fill", ink!.c)}${ink!.dry ? ` filter="url(#${dryFilter(ctx, ink!.dry, seed % 1000)})"` : ""}/>`;
  let a = "";
  if (st.opacity !== undefined && st.opacity < 1) a += ` opacity="${n(st.opacity)}"`;
  if (st.blend && st.blend !== "normal") a += ` style="mix-blend-mode:${st.blend}"`;
  a += filters(ctx, { glow: st.glow, blur: st.blur });
  return a ? `<g${a}>${body}</g>` : body;
}

/** Streaky brush texture multiplied over the paint, kept inside its alpha. */
function brushFilter(ctx: Ctx, strength: number, seed: number): string {
  const k = Math.max(0, Math.min(1, strength));
  const body = `<feTurbulence type="fractalNoise" baseFrequency="0.05 0.45" numOctaves="2" seed="${seed}" result="t"/>` +
    `<feColorMatrix in="t" type="matrix" values="0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0 0 0 0 1"/>` +
    `<feComponentTransfer result="m"><feFuncR type="linear" slope="${n(2 * k)}" intercept="${n(1 - 1.4 * k)}"/><feFuncG type="linear" slope="${n(2 * k)}" intercept="${n(1 - 1.4 * k)}"/><feFuncB type="linear" slope="${n(2 * k)}" intercept="${n(1 - 1.4 * k)}"/></feComponentTransfer>` +
    `<feBlend in="SourceGraphic" in2="m" mode="multiply"/><feComposite in2="SourceGraphic" operator="in"/>`;
  return ctx.def(body, (id) => `<filter id="${id}" x="0" y="0" width="100%" height="100%">${body}</filter>`);
}

/** Dry-brush breaks: fine noise thresholded into the ink's alpha. */
function dryFilter(ctx: Ctx, dry: number, seed: number): string {
  const th = 0.75 - 0.4 * Math.max(0, Math.min(1, dry));
  const body = `<feTurbulence type="fractalNoise" baseFrequency="0.25 0.9" numOctaves="2" seed="${seed}" result="t"/>` +
    `<feColorMatrix in="t" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -8 0 0 0 ${n(8 * th + 1)}" result="m"/>` +
    `<feComposite in="SourceGraphic" in2="m" operator="in"/>`;
  return ctx.def(body, (id) => `<filter id="${id}" x="0" y="0" width="100%" height="100%">${body}</filter>`);
}

/**
 * A raster image: drawn as is, or, in silhouette mode, its alpha grown by `ow` and flooded with the
 * outline color. The growth is a blur of the alpha pushed through a steep threshold (resvg ignores
 * feMorphology): with stdDeviation = ow and the threshold at alpha ≈ 0.1, the edge moves out by ~1.3 ow.
 */
function image(ctx: Ctx, s: ShapeNode, attrs: string, sil?: Sil): string {
  if (sil) {
    const a = s.attrs as Record<string, number>, m = 3 * sil.ow + 1;
    const body = `<feGaussianBlur in="SourceAlpha" stdDeviation="${n(sil.ow)}" result="b"/><feComponentTransfer in="b" result="d"><feFuncA type="linear" slope="40" intercept="-3.4"/></feComponentTransfer><feFlood flood-color="${ctx.color(sil.color).slice(0, 7)}"/><feComposite in2="d" operator="in"/>`;
    const id = ctx.def(`${body}${n(a.x)},${n(a.y)},${n(a.width)},${n(a.height)}`, (id) =>
      `<filter id="${id}" filterUnits="userSpaceOnUse" x="${n(a.x - m)}" y="${n(a.y - m)}" width="${n(a.width + 2 * m)}" height="${n(a.height + 2 * m)}">${body}</filter>`);
    return `<image${attrs} filter="url(#${id})"/>`;
  }
  let a = "";
  if (s.style.opacity !== undefined && s.style.opacity < 1) a += ` opacity="${n(s.style.opacity)}"`;
  if (s.style.blend && s.style.blend !== "normal") a += ` style="mix-blend-mode:${s.style.blend}"`;
  return `<image${attrs}${a}${filters(ctx, s.style)}/>`;
}

function shape(ctx: Ctx, s: ShapeNode, sil?: Sil): string {
  if (s.style.ink || s.style.shade || s.style.hatch || s.style.tone || s.style.spot) return hand(ctx, s, sil);
  const attrs = Object.entries(s.attrs).map(([k, v]) => ` ${k}="${typeof v === "number" ? n(v) : esc(v)}"`).join("");
  if (s.tag === "image") return image(ctx, s, attrs, sil);
  if (sil && s.style.fill === undefined && s.style.stroke === undefined) return "";
  const st = styleAttrs(ctx, s.style, sil);
  if (s.tag === "text") {
    if (s.along) {
      const d = s.along.d, pid = ctx.def(`<path d="${d}"/>`, (id) => `<path id="${id}" d="${d}" fill="none"/>`);
      return `<text${attrs}${st}><textPath href="#${pid}" startOffset="${n(s.along.offset * 100)}%">${esc(s.text ?? "")}</textPath></text>`;
    }
    return `<text${attrs}${st}>${esc(s.text ?? "")}</text>`;
  }
  return `<${s.tag}${attrs}${st}/>`;
}

function node(ctx: Ctx, v: Node, sil?: Sil): string {
  if (v.k === "shape") return shape(ctx, v, sil);
  if (v.k === "clip") {
    // Clipped detail lies inside its mask, so it never grows the silhouette.
    if (sil) return "";
    const id = ctx.id();
    ctx.defs.push(`<clipPath id="${id}">${v.mask.map((m) => node(ctx, m)).join("")}</clipPath>`);
    return `<g clip-path="url(#${id})">${v.children.map((c) => node(ctx, c)).join("")}</g>`;
  }
  if (v.pal) ctx.pals.push(v.pal);
  if (v.swap) ctx.swaps.push(v.swap);
  if (v.boil) ctx.boil += v.boil;
  try {
    let inner: string;
    if (v.silhouette) {
      const s: Sil = sil ? { color: sil.color, ow: sil.ow + v.silhouette.ow } : v.silhouette;
      const shadow = v.children.map((c) => node(ctx, c, s)).join("");
      inner = sil ? shadow : `<g>${shadow}</g>` + v.children.map((c) => node(ctx, c)).join("");
    } else inner = v.children.map((c) => node(ctx, c, sil)).join("");
    let a = v.tf ? ` transform="${v.tf}"` : "";
    if (v.style && !sil) {
      if (v.style.opacity !== undefined && v.style.opacity < 1) a += ` opacity="${n(v.style.opacity)}"`;
      if (v.style.blend && v.style.blend !== "normal") a += ` style="mix-blend-mode:${v.style.blend}"`;
      a += filters(ctx, v.style);
    }
    return a ? `<g${a}>${inner}</g>` : inner;
  } finally {
    if (v.boil) ctx.boil -= v.boil;
    if (v.swap) ctx.swaps.pop();
    if (v.pal) ctx.pals.pop();
  }
}

export interface Serialized {
  defs: string;
  /** One body per top-level node, in order. */
  bodies: string[];
}

export function serialize(nodes: Node[], pal: Palette, prefix = "v"): Serialized {
  const ctx = new Ctx(pal, prefix);
  try {
    const bodies = nodes.map((v) => node(ctx, v));
    return { defs: ctx.defs.join(""), bodies };
  } catch (e) {
    if (e instanceof VexError) throw e;
    throw new VexError(String(e));
  }
}

export function svgDoc(box: Box, defs: string, body: string, scale = 1): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(box.w * scale)}" height="${n(box.h * scale)}" viewBox="${n(box.x)} ${n(box.y)} ${n(box.w)} ${n(box.h)}">` +
    (defs ? `<defs>${defs}</defs>` : "") + body + "</svg>";
}

/** Inner markup (defs + body) of a finished document, for nesting it in another SVG. */
export function innerOf(svg: string): string {
  return svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));
}
