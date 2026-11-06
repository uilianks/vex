// Hand-drawn geometry: shapes flattened to polylines, a seeded wobble shared by the fill and the
// ink, and ink lines as filled outlines whose width varies along the line (taper, pressure, light).
import { VexError } from "./errors.ts";
import type { ShapeNode } from "./model.ts";
import { hash, rng } from "./util.ts";

type P = [number, number];

/** Hand geometry is dense: two decimals keep it exact at any export scale that matters. */
const n = (v: number) => String(Math.round(v * 100) / 100);
/** Spacing of the resampled line in units: fine enough for the wobble and width waves. */
const SPACING = 2;

export interface Poly {
  pts: P[];
  closed: boolean;
}

export interface InkOpts {
  /** Line color. */
  c: string;
  /** Widest width in units. */
  w?: number;
  /** 0..1: how much the width wanders along the line. */
  vary?: number;
  /** 0..1: the share of an open line that tapers to a point at each end. */
  taper?: number;
  /** Wobble amplitude in units (the fill follows it). */
  wobble?: number;
  /** 0..1: dry-brush breaks in the line. */
  dry?: number;
  /** Light direction (degrees, 0 = from above, clockwise): closed lines get heavier on the far side. */
  light?: number;
  /** 0..1: how much heavier the shadow side is. */
  weight?: number;
  /**
   * Brush pressure along the line: widths (0..1 of `w`) spread evenly from start to end and
   * interpolated (`[0.2, 1, 0.4]` swells in the middle), or "bend": heavier where the line turns,
   * as a brush slows into a curve and flicks out of the straights.
   */
  pressure?: number[] | "bend";
  seed?: number;
}

export interface ShadeOpts {
  /** Shadow color (default: two ramp steps darker than the fill, else a translucent dark). */
  c?: string;
  /** Light direction, degrees, 0 = from above, clockwise (default 315: top-left). */
  light?: number;
  /** How far the shadow reaches in from the far edge, as a fraction of the shape's size. */
  depth?: number;
  /** Shadow edge softness, as a fraction of the shape's size. */
  soft?: number;
  /** Highlight on the lit edge: a color, true (one ramp step lighter) or false. */
  hi?: string | boolean;
  /** Rim light on the shadow edge. */
  rim?: string;
  /** 0..1: painted brush texture over the fill and shading. */
  brush?: number;
}

export interface HatchOpts {
  c: string;
  /** Degrees, 0 = horizontal lines. */
  angle?: number;
  gap?: number;
  w?: number;
  opacity?: number;
  cross?: boolean;
}

export interface ToneOpts {
  /** Dot color. */
  c: string;
  /** Distance between dot centres in units (default 4). */
  gap?: number;
  /** Dot diameter as a fraction of the gap, 0..1.4 (default 0.55; above 1 the dots merge). */
  dot?: number;
  /** Screen angle in degrees (default 45). */
  angle?: number;
  opacity?: number;
  /** Gradient tone: the dots shrink to nothing toward this side (degrees, 0 = up, clockwise). */
  fade?: number;
}

export interface SpotOpts {
  /** Spot color (default "k" when the palette has it, else black). */
  c?: string;
  /** Light direction, degrees (default: shade's light, else 315). */
  light?: number;
  /** How far the black reaches in from the far edge, as a fraction of the shape's extent along the light (default 0.3). */
  depth?: number;
}

export const INK_KEYS = ["c", "w", "vary", "taper", "wobble", "dry", "light", "weight", "pressure", "seed"];
export const TONE_KEYS = ["c", "gap", "dot", "angle", "opacity", "fade"];
export const SPOT_KEYS = ["c", "light", "depth"];
export const SHADE_KEYS = ["c", "light", "depth", "soft", "hi", "rim", "brush"];
export const HATCH_KEYS = ["c", "angle", "gap", "w", "opacity", "cross"];

/** Unit vector pointing toward the light (0 = up, clockwise). */
export function lightDir(deg: number): P {
  const a = (deg * Math.PI) / 180;
  return [Math.sin(a), -Math.cos(a)];
}

// ------------------------------------------------------------------ flattening

const STEP = 0.5;

function ellipsePts(cx: number, cy: number, rx: number, ry: number): P[] {
  const k = Math.max(16, Math.min(720, Math.ceil((2 * Math.PI * Math.max(rx, ry)) / STEP)));
  return Array.from({ length: k }, (_, i) => {
    const t = (i / k) * 2 * Math.PI;
    return [cx + Math.cos(t) * rx, cy + Math.sin(t) * ry] as P;
  });
}

function roundRect(x: number, y: number, w: number, h: number, r: number): P[] {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!r) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const out: P[] = [];
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= 8; i++) {
      const t = ((a0 + i * 90 / 8) * Math.PI) / 180;
      out.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
    }
  };
  corner(x + w - r, y + r, -90);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, 90);
  corner(x + r, y + r, 180);
  return out;
}

function cubic(out: P[], p0: P, c1: P, c2: P, p3: P): void {
  const len = Math.hypot(c1[0] - p0[0], c1[1] - p0[1]) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(p3[0] - c2[0], p3[1] - c2[1]);
  const k = Math.max(2, Math.min(256, Math.ceil(len / STEP)));
  for (let i = 1; i <= k; i++) {
    const t = i / k, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1],
    ]);
  }
}

/** SVG elliptical arc (endpoint form) sampled into out. */
function arc(out: P[], p0: P, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, p1: P): void {
  if (!rx || !ry) { out.push(p1); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cxp = (co * rx * y1) / ry, cyp = (-co * ry * x1) / rx;
  const cx = cos * cxp - sin * cyp + (p0[0] + p1[0]) / 2, cy = sin * cxp + cos * cyp + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t0 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const k = Math.max(2, Math.min(720, Math.ceil((Math.abs(dt) * Math.max(rx, ry)) / STEP)));
  for (let i = 1; i <= k; i++) {
    const t = t0 + (dt * i) / k;
    out.push([cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos]);
  }
}

/** Path data -> polylines (one per subpath). Supports every SVG path command. */
export function flattenD(d: string): Poly[] {
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const polys: Poly[] = [];
  let cur: P[] = [], pos: P = [0, 0], start: P = [0, 0], cmd = "", prevC: P | undefined, prevQ: P | undefined;
  let i = 0;
  const num = () => {
    const t = toks[i++];
    const v = Number(t);
    if (t === undefined || !Number.isFinite(v)) throw new VexError(`path: bad path data near '${toks.slice(Math.max(0, i - 3), i + 1).join(" ")}'`);
    return v;
  };
  const flag = () => num() !== 0;
  const end = (closed: boolean) => {
    if (cur.length > 1) polys.push({ pts: cur, closed });
    cur = [];
  };
  while (i < toks.length) {
    if (/[a-z]/i.test(toks[i])) cmd = toks[i++];
    else if (!cmd) throw new VexError("path: path data must start with M");
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const pt = (): P => { const x = num(), y = num(); return rel ? [pos[0] + x, pos[1] + y] : [x, y]; };
    let nc: P | undefined, nq: P | undefined;
    switch (C) {
      case "M":
        end(false);
        pos = pt(); start = pos; cur = [pos];
        cmd = rel ? "l" : "L";
        break;
      case "L": pos = pt(); cur.push(pos); break;
      case "H": { const x = num(); pos = [rel ? pos[0] + x : x, pos[1]]; cur.push(pos); break; }
      case "V": { const y = num(); pos = [pos[0], rel ? pos[1] + y : y]; cur.push(pos); break; }
      case "C": { const c1 = pt(), c2 = pt(), p = pt(); cubic(cur, pos, c1, c2, p); nc = c2; pos = p; break; }
      case "S": {
        const c1: P = prevC ? [2 * pos[0] - prevC[0], 2 * pos[1] - prevC[1]] : pos;
        const c2 = pt(), p = pt(); cubic(cur, pos, c1, c2, p); nc = c2; pos = p; break;
      }
      case "Q": case "T": {
        const q = C === "Q" ? pt() : prevQ ? [2 * pos[0] - prevQ[0], 2 * pos[1] - prevQ[1]] as P : pos;
        const p = pt();
        cubic(cur, pos, [pos[0] + (2 / 3) * (q[0] - pos[0]), pos[1] + (2 / 3) * (q[1] - pos[1])], [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], p);
        nq = q; pos = p; break;
      }
      case "A": {
        const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag(), p = pt();
        arc(cur, pos, rx, ry, rot, large, sweep, p); pos = p; break;
      }
      case "Z":
        end(true);
        pos = start; cur = [pos];
        break;
      default: throw new VexError(`path: unknown command '${cmd}'`);
    }
    prevC = nc; prevQ = nq;
    if (C === "Z" && i < toks.length && !/[a-z]/i.test(toks[i])) throw new VexError("path: numbers after Z");
  }
  end(false);
  return polys.map((p) => ({ pts: dedupe(p.pts, p.closed), closed: p.closed })).filter((p) => p.pts.length > 1);
}

function dedupe(ps: P[], closed: boolean): P[] {
  const out: P[] = [];
  for (const p of ps) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) out.push(p);
  }
  if (closed && out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) out.pop();
  }
  return out;
}

/** The outline of a shape node as polylines, in its own coordinates. */
export function outline(s: ShapeNode): Poly[] {
  const a = s.attrs as Record<string, number>;
  switch (s.tag) {
    case "circle": return [{ pts: ellipsePts(a.cx, a.cy, a.r, a.r), closed: true }];
    case "ellipse": return [{ pts: ellipsePts(a.cx, a.cy, a.rx, a.ry), closed: true }];
    case "rect": return [{ pts: roundRect(a.x, a.y, a.width, a.height, a.rx ?? 0), closed: true }];
    case "path": return flattenD(String(s.attrs.d));
    default: throw new VexError(`ink, shade, hatch, tone and spot work on shapes, not ${s.tag}`);
  }
}

export function bounds(polys: Poly[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p.pts) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return x0 === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ------------------------------------------------------------------ wobble and ink

/** Resample at even spacing (closed: wraps; open: keeps both ends). */
function resample(p: Poly, maxPts = 2400): { pts: P[]; s: number[]; len: number } {
  const ps = p.closed ? [...p.pts, p.pts[0]] : p.pts;
  const acc = [0];
  for (let i = 1; i < ps.length; i++) acc.push(acc[i - 1] + Math.hypot(ps[i][0] - ps[i - 1][0], ps[i][1] - ps[i - 1][1]));
  const len = acc[acc.length - 1];
  const count = Math.max(p.closed ? 8 : 2, Math.min(maxPts, Math.ceil(len / SPACING)));
  const segs = p.closed ? count : count - 1;
  const pts: P[] = [], s: number[] = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const d = (k / segs) * len;
    while (j < acc.length - 2 && acc[j + 1] < d) j++;
    const t = acc[j + 1] > acc[j] ? (d - acc[j]) / (acc[j + 1] - acc[j]) : 0;
    pts.push([ps[j][0] + (ps[j + 1][0] - ps[j][0]) * t, ps[j][1] + (ps[j + 1][1] - ps[j][1]) * t]);
    s.push(d);
  }
  return { pts, s, len };
}

/** Smooth 1D value noise in -1..1 along a line; periodic over `len` when closed so loops don't seam. */
function noise1(seed: number, len: number, wave: number, closed: boolean): (s: number) => number {
  const cells = Math.max(closed ? 3 : 1, Math.round(len / wave));
  const r = rng(seed);
  const v = Array.from({ length: cells + 2 }, () => r() * 2 - 1);
  return (s) => {
    const x = (s / len) * cells, i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    const at = (k: number) => v[closed ? ((k % cells) + cells) % cells : Math.min(k, cells + 1)];
    return at(i) + (at(i + 1) - at(i)) * u;
  };
}

function normals(pts: P[], closed: boolean): P[] {
  const len = pts.length;
  return pts.map((_, i) => {
    const a = closed ? pts[(i - 1 + len) % len] : pts[Math.max(0, i - 1)];
    const b = closed ? pts[(i + 1) % len] : pts[Math.min(len - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], m = Math.hypot(dx, dy) || 1;
    return [dy / m, -dx / m] as P;
  });
}

/** Signed area: > 0 when the points run clockwise in SVG's y-down space. */
function area(pts: P[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export interface Line {
  pts: P[];
  s: number[];
  len: number;
  closed: boolean;
}

/** Seed for a shape: its geometry plus the user seed and the boil offset. */
export function shapeSeed(s: ShapeNode, user = 0, boil = 0): number {
  return (hash(JSON.stringify(s.attrs)) + user * 7919 + boil * 104729) >>> 0;
}

/** The shape's outline pushed around by a seeded wobble (amp 0 = exact). */
export function wobbled(polys: Poly[], amp: number, seed: number): Line[] {
  return polys.map((p, k) => {
    const r = resample(p);
    if (!amp) return { ...r, closed: p.closed };
    const big = noise1(seed + k * 31, r.len, 26, p.closed), small = noise1(seed + k * 31 + 17, r.len, 7, p.closed);
    const nm = normals(r.pts, p.closed);
    const pts = r.pts.map((q, i) => {
      // open lines keep their ends where they were drawn
      const pin = p.closed ? 1 : Math.min(1, r.s[i] / 4, (r.len - r.s[i]) / 4);
      const d = amp * pin * (big(r.s[i]) + 0.35 * small(r.s[i]));
      return [q[0] + nm[i][0] * d, q[1] + nm[i][1] * d] as P;
    });
    return { pts, s: r.s, len: r.len, closed: p.closed };
  });
}

/** Compact path data: first point absolute, then relative steps between the rounded points. */
function relD(pts: P[], closed: boolean): string {
  const r = pts.map(([x, y]) => [Math.round(x * 100), Math.round(y * 100)]);
  let d = `M${n(r[0][0] / 100)} ${n(r[0][1] / 100)}l`;
  for (let i = 1; i < r.length; i++) d += `${i > 1 ? " " : ""}${n((r[i][0] - r[i - 1][0]) / 100)} ${n((r[i][1] - r[i - 1][1]) / 100)}`;
  return d.replace(/(^|[ l-])0\./g, "$1.").replace(/ -/g, "-") + (closed ? "Z" : "");
}

export function linesD(lines: Line[]): string {
  return lines.filter((l) => l.closed).map((l) => relD(l.pts, true)).join("");
}

/** Ink as filled outlines: each line becomes a band whose width varies along it. */
export function inkD(lines: Line[], o: InkOpts, seed: number): string {
  const w = o.w ?? 2, vary = o.vary ?? 0.35, taper = o.taper ?? 0.3, weight = o.weight ?? 0.5;
  const L = lightDir(o.light ?? 315);
  let d = "";
  lines.forEach((l, k) => {
    const nm = normals(l.pts, l.closed);
    const press = noise1(seed + 977 + k * 13, l.len, 18, l.closed);
    // outward normals for closed lines, whatever their winding
    const out = l.closed && area(l.pts) < 0 ? -1 : 1;
    const brush = pressureAt(l, o.pressure);
    const half = l.pts.map((_, i) => {
      let f = (1 + vary * press(l.s[i])) * brush(i);
      if (l.closed) f *= 1 - weight * out * (nm[i][0] * L[0] + nm[i][1] * L[1]);
      else if (taper > 0) {
        const e = Math.min(l.s[i], l.len - l.s[i]) / (taper * l.len / 2 || 1);
        f *= Math.min(1, e) ** 0.7;
      }
      return Math.max(0, (w / 2) * f / (1 + vary) / (l.closed ? 1 + weight : 1));
    });
    const side = (sgn: number) => l.pts.map((p, i) => [p[0] + nm[i][0] * half[i] * sgn, p[1] + nm[i][1] * half[i] * sgn] as P);
    const left = side(1), right = side(-1).reverse();
    // closed: outer ring forward, inner ring backward, so nonzero fills only the band
    d += l.closed ? relD(left, true) + relD(right, true) : relD([...left, ...right], true);
  });
  return d;
}

/** Pressure multiplier (0..1) per resampled point of a line. */
function pressureAt(l: Line, p: InkOpts["pressure"]): (i: number) => number {
  if (p === undefined) return () => 1;
  if (p === "bend") {
    // turn angle over a short window, normalised: a quarter turn within ~12 units is full pressure
    const m = l.pts.length, k = 3;
    const at = (i: number) => l.pts[l.closed ? ((i % m) + m) % m : Math.max(0, Math.min(m - 1, i))];
    const turn = l.pts.map((_, i) => {
      const a = at(i - k), b = at(i), c = at(i + k);
      const t = Math.abs(Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])));
      return Math.min(1, t / (Math.PI / 4));
    });
    return (i) => 0.35 + 0.65 * turn[i];
  }
  const v = p.map((x) => Math.max(0, x));
  if (v.length === 1) return () => v[0];
  return (i) => {
    const x = (l.s[i] / (l.len || 1)) * (v.length - 1), j = Math.min(v.length - 2, Math.floor(x)), f = x - j;
    return v[j] + (v[j + 1] - v[j]) * f;
  };
}

// ------------------------------------------------------------------ comic: tone and speed lines

const circleD = (x: number, y: number, r: number) => `M${n(x - r)} ${n(y)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0`;

/**
 * A gradient screentone as geometry: dots on the screen lattice over the box, shrinking to nothing
 * toward `fade`. (A flat tone is an SVG pattern; dots of changing size have to be drawn.)
 */
export function toneFadeD(b: { x: number; y: number; w: number; h: number }, o: ToneOpts): string {
  const gap = o.gap ?? 4, r0 = ((o.dot ?? 0.55) * gap) / 2, a = ((o.angle ?? 45) * Math.PI) / 180;
  const ux: P = [Math.cos(a), Math.sin(a)], uy: P = [-Math.sin(a), Math.cos(a)];
  const F = lightDir(o.fade ?? 0);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, R = Math.hypot(b.w, b.h) / 2 + gap;
  // projection of the box corners on the fade direction: 0 on the far side, 1 at the fading edge
  const proj = (x: number, y: number) => (x - cx) * F[0] + (y - cy) * F[1];
  const ext = Math.abs(F[0]) * b.w / 2 + Math.abs(F[1]) * b.h / 2 || 1;
  const k = Math.ceil(R / gap);
  if ((2 * k + 1) ** 2 > 250000) throw new VexError(`tone fade: ${(2 * k + 1) ** 2} dots; use a larger gap for a shape this size`);
  let d = "";
  for (let i = -k; i <= k; i++) for (let j = -k; j <= k; j++) {
    const x = cx + (i * ux[0] + j * uy[0]) * gap, y = cy + (i * ux[1] + j * uy[1]) * gap;
    if (x < b.x - gap || x > b.x + b.w + gap || y < b.y - gap || y > b.y + b.h + gap) continue;
    const t = (proj(x, y) / ext + 1) / 2, r = r0 * (1 - Math.max(0, Math.min(1, t)));
    if (r > 0.12) d += circleD(x, y, r);
  }
  return d;
}

export interface SpeedOpts {
  /** The area the lines fill: [x, y, w, h]. */
  area: [number, number, number, number];
  /** Radial (focus) lines converge on this point. */
  at?: [number, number];
  /** Parallel (motion) lines run in this direction, degrees (0 = right, 90 = down). */
  angle?: number;
  count?: number;
  /** Widest width of a line in units. */
  w?: number;
  /** Radial: share of the distance to the nearest edge kept clear around `at` (0..1). */
  inner?: number;
  /** Line length as a fraction of the area's extent: [min, max]. */
  length?: [number, number];
  seed?: number;
}

/** Speed lines as filled tapered wedges: radial focus lines or parallel motion lines. */
export function speedLinesD(o: SpeedOpts): string {
  const [x, y, w, h] = o.area, r = rng(o.seed ?? 1), count = o.count ?? 60, lw = o.w ?? 3;
  const [l0, l1] = o.length ?? (o.at ? [0.5, 1] : [0.25, 0.7]);
  const wedge = (bx: number, by: number, tx: number, ty: number, half: number): string => {
    const dx = tx - bx, dy = ty - by, m = Math.hypot(dx, dy) || 1, nx = -dy / m * half, ny = dx / m * half;
    return `M${n(bx + nx)} ${n(by + ny)}L${n(tx)} ${n(ty)}L${n(bx - nx)} ${n(by - ny)}Z`;
  };
  let d = "";
  if (o.at) {
    const [cx, cy] = o.at, far = Math.hypot(Math.max(cx - x, x + w - cx), Math.max(cy - y, y + h - cy)) + lw;
    const near = Math.min(cx - x, x + w - cx, cy - y, y + h - cy);
    const clear = Math.max(0, near) * (o.inner ?? 0.45);
    for (let i = 0; i < count; i++) {
      const a = ((i + r() * 0.8) / count) * 2 * Math.PI, len = (far - clear) * (l0 + (l1 - l0) * r());
      const tip = far - len, c = Math.cos(a), s = Math.sin(a);
      d += wedge(cx + c * far, cy + s * far, cx + c * Math.max(clear, tip), cy + s * Math.max(clear, tip), (lw / 2) * (0.35 + 0.65 * r()));
    }
  } else {
    const a = ((o.angle ?? 0) * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a);
    const ext = Math.abs(ux) * w + Math.abs(uy) * h, span = Math.abs(uy) * w + Math.abs(ux) * h;
    const cx = x + w / 2, cy = y + h / 2;
    for (let i = 0; i < count; i++) {
      const off = ((i + r()) / count - 0.5) * span, len = ext * (l0 + (l1 - l0) * r());
      const along = (r() - 0.5) * (ext - len) ;
      // the head (wide) leads in the direction of motion; the tail thins to a point behind it
      const hx = cx - uy * off + ux * (along + len / 2), hy = cy + ux * off + uy * (along + len / 2);
      d += wedge(hx, hy, hx - ux * len, hy - uy * len, (lw / 2) * (0.3 + 0.7 * r()));
    }
  }
  return d;
}
