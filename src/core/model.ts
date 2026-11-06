// The data an art file produces. Definitions are plain data + closures; nothing is resolved
// until build time, so references between assets are order-independent.
import type { HatchOpts, InkOpts, ShadeOpts, SpotOpts, ToneOpts } from "./hand.ts";
import type { Palette } from "./palette.ts";

export interface Grad {
  __grad: "lin" | "rad";
  /** [color, offset 0..1]. */
  stops: [string, number][];
  /** lin: direction in degrees (0 = left -> right, 90 = top -> bottom). */
  angle?: number;
  /** rad: center and radius as fractions of the shape's bounding box. */
  cx?: number;
  cy?: number;
  r?: number;
}

/** A repeating asset as a fill or stroke (an SVG pattern). */
export interface Pat {
  __pat: true;
  name: string;
  /** Tile size in units (default: the asset's box). */
  w?: number;
  h?: number;
  /** Tile origin offset, rotation (degrees) and scale of the tiling. */
  x?: number;
  y?: number;
  rot?: number;
  scale?: number;
  opacity?: number;
  /** Filled in at build time: the asset's nodes, palette and drawn box. */
  built?: { nodes: Node[]; pal: Palette; box: { x: number; y: number; w: number; h: number } };
}

export type Paint = string | Grad | Pat;

export interface GlowOpts {
  r: number;
  color?: string;
  /** 1..4 stacked halos. */
  strength?: number;
}

/** Paint and effect options shared by shapes and groups. */
export interface Style {
  fill?: Paint;
  stroke?: Paint;
  /** Stroke width. */
  sw?: number;
  opacity?: number;
  cap?: "round" | "butt" | "square";
  join?: "round" | "miter" | "bevel";
  dash?: number[];
  glow?: number | GlowOpts;
  blur?: number;
  /** Fill the shape with grey fractal noise instead of its paint (film grain, concrete, rust). */
  grain?: GrainOpts;
  /** CSS mix-blend-mode: "screen", "multiply", "overlay", "soft-light", ... */
  blend?: string;
  /** Hand-drawn ink line along the outline; the fill follows its wobble. */
  ink?: InkOpts;
  /** Painted form shading from one light direction. */
  shade?: ShadeOpts;
  /** Line hatching inside the shape (only in the shadow when the shape is shaded). */
  hatch?: HatchOpts;
  /** Screentone dots inside the shape (only in the shadow when the shape is shaded). */
  tone?: ToneOpts;
  /** Spot black: the shape's shadow side filled solid with a hard edge. */
  spot?: SpotOpts;
}

export interface GrainOpts {
  /** Noise frequency per unit (default 1; higher = finer). */
  freq?: number;
  octaves?: number;
  seed?: number;
}

export const STYLE_KEYS = ["fill", "stroke", "sw", "opacity", "cap", "join", "dash", "glow", "blur", "grain", "blend", "ink", "shade", "hatch", "tone", "spot"];

/** A resolved, drawable element. */
export type Node = ShapeNode | GroupNode | ClipNode;

export interface Step {
  label: string;
  loc?: string;
}

export interface ShapeNode {
  k: "shape";
  tag: "path" | "rect" | "circle" | "ellipse" | "text" | "image";
  attrs: Record<string, string | number>;
  text?: string;
  /** text: path data to lay the text along (textPath), and where along it to start (0..1). */
  along?: { d: string; offset: number };
  style: Style;
  step?: Step;
}

export interface GroupNode {
  k: "g";
  /** SVG transform attribute. */
  tf?: string;
  style?: Style;
  /** Color-key replacements for everything inside. */
  swap?: Record<string, string>;
  /** Palette of the asset instance this group stands for. */
  pal?: Palette;
  /** Draw the children as one solid silhouette, grown by `ow` (auto-outline). */
  silhouette?: { color: string; ow: number };
  /** Reseeds the ink wobble inside (an anim's boil step). */
  boil?: number;
  children: Node[];
  step?: Step;
}

export interface ClipNode {
  k: "clip";
  mask: Node[];
  children: Node[];
  step?: Step;
}

/** Frame info handed to function items. */
export interface FrameInfo {
  /** Frame index and count (1 for still assets). */
  i: number;
  n: number;
  /** i / n: 0 up to just below 1; loops seamlessly. */
  t: number;
  /** amp * sin(2π (t * cycles + phase)). */
  sin(amp?: number, phase?: number, cycles?: number): number;
  cos(amp?: number, phase?: number, cycles?: number): number;
  /** Deterministic random numbers for this asset (same every build). */
  rng(seed?: number): () => number;
}

/** Deferred items, resolved at build time. */
export interface Ref {
  __ref: "stamp" | "scatter" | "tile" | "tf" | "clip" | "sym" | "radial";
  args: unknown[];
  step: Step;
}

export type Item = Node | Ref | ((f: FrameInfo) => unknown) | Item[] | null | undefined | false;

export type AssetKind = "sprite" | "scene" | "anim";

export interface AssetOpts {
  w?: number;
  h?: number;
  base?: string;
  bg?: Paint;
  mx?: boolean;
  my?: boolean;
  swap?: Record<string, string>;
  flip?: "x" | "y" | "xy";
  rot?: number;
  outline?: string;
  /** Outline width (default 2). */
  ow?: number;
  /** Export pixels per unit (default 1). */
  scale?: number;
  /** 9-slice margins [left, top, right, bottom] in units, for stretchable UI. */
  slice?: [number, number, number, number];
  frames?: number;
  fps?: number;
  /** Anims: redraw the ink wobble every N frames, like hand-drawn line boil. */
  boil?: number;
}

export interface AssetDef {
  kind: AssetKind;
  name: string;
  opts: AssetOpts;
  items: Item[];
  pal: Palette;
  loc?: string;
}

export interface GroupDef {
  name: string;
  members: string[];
  loc?: string;
}

export interface SheetDef {
  name: string;
  entries: string[];
  opts: { cols?: number; pad?: number; scale?: number };
  loc?: string;
}

export interface UseOpts {
  scale?: number | [number, number];
  rot?: number;
  flip?: "x" | "y" | "xy";
  /** Placement point as fractions of the asset box, or "center" / "bottom" / "top". Default [0, 0]. */
  anchor?: [number, number] | "center" | "bottom" | "top";
  swap?: Record<string, string>;
  opacity?: number;
  /** Show this frame of an anim (default: follow the frame being built). */
  frame?: number;
  /** Frame offset for anims, to desync copies. */
  delay?: number;
  /** Reroll random choices inside the placed asset. */
  seed?: number;
}

export function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && "k" in v && ["shape", "g", "clip"].includes((v as Node).k);
}

export function isRef(v: unknown): v is Ref {
  return typeof v === "object" && v !== null && "__ref" in v;
}

export function isGrad(v: unknown): v is Grad {
  return typeof v === "object" && v !== null && "__grad" in v;
}

export function isPat(v: unknown): v is Pat {
  return typeof v === "object" && v !== null && (v as Pat).__pat === true;
}
