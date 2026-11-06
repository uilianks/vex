// Project: the registry an art file fills in (the DSL), plus the lazy, cached, cycle-checked
// builder that turns definitions into resolved node trees.
import { VexError, didYouMean, wrap } from "./errors.ts";
import { type Clip, type Rig, checkClip, isRig, makeRig, sample } from "./rig.ts";
import { checkParticles, simulate } from "./vfx.ts";
import { type LegendEntry, type LevelGrid, buildGrid, parseMap, platformer } from "./level.ts";
import { type HatchOpts, type InkOpts, type ShadeOpts, type SpeedOpts, type SpotOpts, type ToneOpts, HATCH_KEYS, INK_KEYS, SHADE_KEYS, SPOT_KEYS, TONE_KEYS, speedLinesD } from "./hand.ts";
import { lsystem, noise2, turtle, tween } from "./gen.ts";
import { arcD, points, polyD, smoothD, starD } from "./geom.ts";
import {
  type AssetDef, type AssetKind, type AssetOpts, type FrameInfo, type GroupDef, type Grad, type Item, type Node,
  type Paint, type Pat, type Ref, type SheetDef, type ShapeNode, type Step, type Style, type UseOpts, STYLE_KEYS, isGrad, isNode, isPat, isRef,
} from "./model.ts";
import { Palette } from "./palette.ts";
import { type Box, serialize, svgDoc } from "./svg.ts";
import { fmtArgs, globRe, hash, n, pickRange, rng } from "./util.ts";

const ASSET_OPTS: Record<AssetKind, string[]> = {
  sprite: ["w", "h", "base", "mx", "my", "swap", "flip", "rot", "outline", "ow", "scale", "slice"],
  scene: ["w", "h", "bg", "base", "mx", "my", "swap", "flip", "rot", "outline", "ow", "scale"],
  anim: ["w", "h", "bg", "base", "mx", "my", "swap", "flip", "rot", "outline", "ow", "scale", "frames", "fps", "boil"],
};
const USE_OPTS = ["scale", "rot", "flip", "anchor", "swap", "opacity", "frame", "delay", "seed"];
const SCATTER_OPTS = USE_OPTS;
const TILE_OPTS = [...USE_OPTS, "dx", "dy"];
const TF_OPTS = ["x", "y", "rot", "scale", "flip", "origin", "opacity", "glow", "blur", "blend"];
const SHEET_OPTS = ["cols", "pad", "scale"];
const PAT_OPTS = ["w", "h", "x", "y", "rot", "scale", "opacity"];
const IMAGE_OPTS = ["w", "h", "opacity", "pixel", "blend", "glow", "blur"];
const BLENDS = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"];

/** Shape ops: argument spec ("n" number, "s" string, "a" point list) and extra option keys. */
const SHAPES: Record<string, { args: string; extra: string[]; stroke?: boolean }> = {
  rect: { args: "x:n y:n w:n h:n", extra: ["r"] },
  circle: { args: "cx:n cy:n r:n", extra: [] },
  ellipse: { args: "cx:n cy:n rx:n ry:n", extra: [] },
  poly: { args: "points:a", extra: [] },
  blob: { args: "points:a", extra: ["smooth"] },
  line: { args: "points:a", extra: [], stroke: true },
  curve: { args: "points:a", extra: ["smooth"], stroke: true },
  path: { args: "d:s", extra: [] },
  star: { args: "cx:n cy:n points:n r1:n r2:n", extra: ["rot"] },
  ngon: { args: "cx:n cy:n sides:n r:n", extra: ["rot"] },
  arc: { args: "cx:n cy:n r:n from:n to:n", extra: ["pie"], stroke: true },
  text: { args: "x:n y:n str:s", extra: ["size", "font", "anchor", "weight", "along", "offset", "smooth"] },
};

/** A decoded raster for image(): size and a data URI (the loader fills it in). */
export interface ImageRef {
  w: number;
  h: number;
  href: string;
}

export interface StepInfo {
  label: string;
  loc?: string;
  /** Number of raw nodes after this step. */
  end: number;
}

export interface Built {
  name: string;
  kind: AssetKind;
  /** Declared size (placement box). */
  w: number;
  h: number;
  /** Drawn area (grows with outline). */
  box: Box;
  /** Final nodes. */
  nodes: Node[];
  /** Nodes before mirror/swap/flip/rot/outline, for step replay. */
  raw: Node[];
  steps: StepInfo[];
  /** Post-processing applied after the steps, by name. */
  post: string[];
  pal: Palette;
  frame: number;
  frames: number;
  fps: number;
  scale: number;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !isNode(v) && !isRef(v) && !isGrad(v);
}

function checkKeys(what: string, obj: object, allowed: string[]): void {
  for (const k of Object.keys(obj))
    if (!allowed.includes(k)) throw new VexError(`${what}: unknown option '${k}'${didYouMean(k, allowed)} (allowed: ${allowed.join(", ")})`);
}

function nums(what: string, o: Record<string, unknown>, keys: string[]): void {
  for (const k of keys) if (o[k] !== undefined && !(typeof o[k] === "number" && Number.isFinite(o[k])))
    throw new VexError(`${what} ${k} must be a number, got ${JSON.stringify(o[k])}`);
}

function checkArgs(name: string, spec: string, args: unknown[]): void {
  spec.split(" ").forEach((part, i) => {
    const [pname, type] = part.split(":");
    const v = args[i];
    const usage = `${name}(${spec.split(" ").map((p) => p.split(":")[0]).join(", ")}, style)`;
    if (v === undefined) throw new VexError(`missing argument ${i + 1} (${pname}); usage: ${usage}`);
    const bad = (want: string) => { throw new VexError(`argument ${i + 1} (${pname}) must be ${want}, got ${JSON.stringify(v) ?? typeof v}; usage: ${usage}`); };
    if (type === "n" && (typeof v !== "number" || !Number.isFinite(v))) bad("a number");
    if (type === "s" && typeof v !== "string") bad("a string");
    if (type === "a" && !Array.isArray(v)) bad("a point list [x0, y0, x1, y1, ...]");
  });
}

function tfString(x: number, y: number, rot = 0, sx = 1, sy = 1, ox = 0, oy = 0): string | undefined {
  const parts: string[] = [];
  if (x || y) parts.push(`translate(${n(x)} ${n(y)})`);
  if (rot) parts.push(`rotate(${n(rot)})`);
  if (sx !== 1 || sy !== 1) parts.push(`scale(${n(sx)} ${n(sy)})`);
  if (ox || oy) parts.push(`translate(${n(-ox)} ${n(-oy)})`);
  return parts.length ? parts.join(" ") : undefined;
}

function flipXY(flip: unknown, what: string): [number, number] {
  if (flip === undefined) return [1, 1];
  if (flip !== "x" && flip !== "y" && flip !== "xy") throw new VexError(`${what}: flip must be "x", "y" or "xy"`);
  return [flip.includes("x") ? -1 : 1, flip.includes("y") ? -1 : 1];
}

function anchorOf(a: UseOpts["anchor"], dflt: [number, number]): [number, number] {
  if (a === undefined) return dflt;
  if (a === "center") return [0.5, 0.5];
  if (a === "bottom") return [0.5, 1];
  if (a === "top") return [0.5, 0];
  if (Array.isArray(a) && a.length === 2 && a.every((v) => typeof v === "number")) return a;
  throw new VexError(`anchor must be [ax, ay] (fractions of the asset box), "center", "bottom" or "top"`);
}

function frameInfo(i: number, count: number, seed: number): FrameInfo {
  const t = i / count;
  return {
    i, n: count, t,
    sin: (amp = 1, phase = 0, cycles = 1) => amp * Math.sin(2 * Math.PI * (t * cycles + phase)),
    cos: (amp = 1, phase = 0, cycles = 1) => amp * Math.cos(2 * Math.PI * (t * cycles + phase)),
    rng: (s = 0) => rng(seed + s),
  };
}

export class Project {
  readonly assets = new Map<string, AssetDef>();
  readonly order: string[] = [];
  readonly groups = new Map<string, GroupDef>();
  readonly sheets: SheetDef[] = [];
  readonly spines: SpineDef[] = [];
  readonly tilesets = new Map<string, TilesetDef>();
  readonly levels: LevelDef[] = [];
  readonly fonts: FontDef[] = [];
  /** Art files loaded so far (absolute paths or virtual names), for locations and watching. */
  readonly files: string[] = [];
  pal: Palette = Palette.builtin("sweetie16");
  /** Set by a loader to support include(). */
  includeHook?: (path: string) => void;
  /** Set by a loader: resolves a path written in an art file (image sources) against that file. */
  pathHook: (path: string) => string = (p) => p;
  /** Set by a loader: reads an image file (PNG, JPEG, GIF) by its resolved path. */
  imageHook?: (path: string) => ImageRef;
  private images = new Map<string, ImageRef>();

  private cache = new Map<string, Built>();
  private building = new Set<string>();
  private failed = new Map<string, VexError>();

  // ---------------------------------------------------------------- locations

  addFile(file: string): void {
    if (!this.files.includes(file)) this.files.push(file);
  }

  locFromStack(stack: string): string | undefined {
    for (const line of stack.split("\n")) {
      for (const f of this.files) {
        const i = line.indexOf(f + ":");
        if (i < 0) continue;
        const m = /^:(\d+):(\d+)/.exec(line.slice(i + f.length));
        if (m) return `${f.replace(/^.*[\\/]/, "")}:${m[1]}:${m[2]}`;
      }
    }
    return undefined;
  }

  callerLoc(): string | undefined {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 60;
    const stack = new Error().stack ?? "";
    Error.stackTraceLimit = limit;
    return this.locFromStack(stack);
  }

  // ---------------------------------------------------------------- DSL

  /** Functions visible to art files. */
  env(): Record<string, unknown> {
    const env: Record<string, unknown> = {};
    /** Run fn with the caller's location attached to any error. */
    const at = <T>(what: string, fn: (loc?: string) => T): T => {
      const loc = this.callerLoc();
      try { return fn(loc); } catch (e) { throw wrap(e).within(what, loc); }
    };
    const color = (c: unknown, what: string): string => {
      if (typeof c !== "string") throw new VexError(`${what} must be a color string, got ${JSON.stringify(c) ?? typeof c}`);
      this.pal.resolve(c);
      return c;
    };
    const paintArg = (p: unknown, what: string): Paint => (isGrad(p) || isPat(p) ? p : color(p, what));
    const styleArg = (v: unknown, extra: string[], strokeDefault: boolean): { style: Style; ex: Record<string, unknown> } => {
      if (v === undefined) throw new VexError(`needs a style: a color ("g") or { fill, stroke, sw, ... }`);
      if (typeof v === "string" || isGrad(v)) return { style: strokeDefault ? { stroke: paintArg(v, "stroke"), sw: 1 } : { fill: paintArg(v, "fill") }, ex: {} };
      if (!isPlain(v)) throw new VexError(`style must be a color or an options object`);
      checkKeys("style", v, [...STYLE_KEYS, ...extra]);
      const style: Style = {}, ex: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        if (extra.includes(k)) ex[k] = val;
        else if (k === "fill" || k === "stroke") style[k] = paintArg(val, k);
        else if (k === "glow" && isPlain(val)) {
          checkKeys("glow", val, ["r", "color", "strength"]);
          if (val.color !== undefined) color(val.color, "glow color");
          style.glow = val as unknown as Style["glow"];
        } else if (k === "grain") {
          if (!isPlain(val)) throw new VexError("grain must be { freq, octaves, seed }");
          checkKeys("grain", val, ["freq", "octaves", "seed"]);
          style.grain = val as Style["grain"];
        } else if (k === "ink" || k === "hatch" || k === "tone") {
          const keys = k === "ink" ? INK_KEYS : k === "hatch" ? HATCH_KEYS : TONE_KEYS;
          const o = typeof val === "string" ? { c: val } : val;
          if (!isPlain(o)) throw new VexError(`${k} must be a color or { ${keys.join(", ")} }`);
          checkKeys(k, o, keys);
          color(o.c, `${k} c`);
          nums(k, o, keys.filter((x) => x !== "c" && x !== "cross" && x !== "pressure"));
          if (o.pressure !== undefined && o.pressure !== "bend" && !(Array.isArray(o.pressure) && o.pressure.length && o.pressure.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)))
            throw new VexError(`ink pressure must be a list of widths 0..1 along the line ([0.2, 1, 0.4]) or "bend"`);
          if (k === "tone" && o.gap !== undefined && !((o.gap as number) >= 1)) throw new VexError("tone gap must be at least 1 unit");
          style[k] = o as unknown as InkOpts & HatchOpts & ToneOpts;
        } else if (k === "spot") {
          const o = typeof val === "string" ? { c: val } : val === true ? {} : val;
          if (!isPlain(o)) throw new VexError(`spot must be true, a color or { ${SPOT_KEYS.join(", ")} }`);
          checkKeys("spot", o, SPOT_KEYS);
          if (o.c !== undefined) color(o.c, "spot c");
          nums("spot", o, ["light", "depth"]);
          style.spot = o as SpotOpts;
        } else if (k === "shade") {
          const o = val === true ? {} : val;
          if (!isPlain(o)) throw new VexError(`shade must be true or { ${SHADE_KEYS.join(", ")} }`);
          checkKeys("shade", o, SHADE_KEYS);
          for (const c of ["c", "rim"]) if (o[c] !== undefined) color(o[c], `shade ${c}`);
          if (typeof o.hi === "string") color(o.hi, "shade hi");
          else if (o.hi !== undefined && typeof o.hi !== "boolean") throw new VexError("shade hi must be a color, true or false");
          nums("shade", o, ["light", "depth", "soft", "brush"]);
          style.shade = o as ShadeOpts;
        } else if (k === "blend") {
          if (!BLENDS.includes(val as string)) throw new VexError(`blend must be one of ${BLENDS.join(", ")}${didYouMean(String(val), BLENDS)}`);
          style.blend = val as string;
        } else (style as Record<string, unknown>)[k] = val;
      }
      if ((style.ink || style.shade || style.hatch || style.tone || style.spot) && style.grain) throw new VexError("grain can't be combined with ink, shade, hatch, tone or spot; put the grain on its own shape");
      if (style.spot && style.fill === undefined) throw new VexError("spot needs a fill (the black goes on its shadow side)");
      if (style.shade && style.fill === undefined) throw new VexError("shade needs a fill to shade");
      if (style.fill === undefined && style.stroke === undefined && !style.ink) {
        if (strokeDefault) throw new VexError(`style needs a stroke (or fill)`);
        throw new VexError(`style needs a fill or a stroke`);
      }
      return { style, ex };
    };

    env.use = (p: unknown) => at("use", () => {
      if (Array.isArray(p)) this.pal = Palette.fromColors(p as string[]);
      else if (typeof p === "string") this.pal = Palette.builtin(p);
      else throw new VexError('use("sweetie16") or use(["#000", "#fff", ...])');
    });
    env.pal = (aliases: unknown) => at("pal", () => {
      if (!isPlain(aliases)) throw new VexError('pal({ k: "#1b1630", g: 6 })');
      this.pal = this.pal.extend(aliases as Record<string, string>);
    });
    env.ramps = (...ramps: unknown[]) => at("ramps", () => { this.pal = this.pal.withRamps(ramps as string[]); });
    env.dark = (key: unknown, steps: unknown = 1) => at("dark", () => this.pal.step(color(key, "key"), -Number(steps)));
    env.lite = (key: unknown, steps: unknown = 1) => at("lite", () => this.pal.step(color(key, "key"), Number(steps)));
    const stops = (cs: unknown, what: string): [string, number][] => {
      if (!Array.isArray(cs) || cs.length < 2) throw new VexError(`${what} needs a color list like ["w", "g"] or [["w", 0], ["g", 1]]`);
      return cs.map((c, i) => (Array.isArray(c) ? [color(c[0], "stop"), Number(c[1])] : [color(c, "stop"), i / (cs.length - 1)]));
    };
    env.lin = (cs: unknown, angle: unknown = 90): Grad => at("lin", () => {
      if (typeof angle !== "number") throw new VexError("lin(colors, angleDegrees)");
      return { __grad: "lin", stops: stops(cs, "lin"), angle };
    });
    env.rad = (cs: unknown, o: unknown = {}): Grad => at("rad", () => {
      if (!isPlain(o)) throw new VexError("rad(colors, { cx, cy, r })");
      checkKeys("rad", o, ["cx", "cy", "r"]);
      return { __grad: "rad", stops: stops(cs, "rad"), ...(o as { cx?: number }) };
    });
    env.pat = (name: unknown, o: unknown = {}): Pat => at("pat", () => {
      if (typeof name !== "string" || !name) throw new VexError('pat("asset", { w, h, x, y, rot, scale, opacity }): a repeating asset as a fill or stroke');
      if (!isPlain(o)) throw new VexError("pat options must be an object");
      checkKeys("pat", o, PAT_OPTS);
      nums("pat", o, PAT_OPTS);
      return { __pat: true, name, ...(o as Partial<Pat>) };
    });
    env.noise = (x: unknown, y: unknown, seed: unknown = 0) => at("noise", () => {
      if (typeof seed !== "number") throw new VexError("noise(x, y, seed): seed must be a number");
      return noise2(x as number, y as number, seed);
    });
    env.lsystem = (spec: unknown) => at("lsystem", () => lsystem(spec));
    env.turtle = (cmds: unknown, o?: unknown) => at("turtle", () => turtle(cmds, o));
    env.tween = (a: unknown, b: unknown, t: unknown) => at("tween", () => tween(a, b, t));
    env.image = (src: unknown, x: unknown, y: unknown, o: unknown = {}): ShapeNode => at("image", (loc) => {
      if (typeof src !== "string" || !src) throw new VexError('image("file.png", x, y, { w, h, opacity, pixel, blend, glow, blur })');
      checkArgs("image", "src:s x:n y:n", [src, x, y]);
      if (!isPlain(o)) throw new VexError("image options must be an object");
      checkKeys("image", o, IMAGE_OPTS);
      nums("image", o, ["w", "h", "opacity", "blur"]);
      if (!this.imageHook) throw new VexError("image() is not available here (no image loader)");
      const abs = this.pathHook(src);
      let img = this.images.get(abs);
      if (!img) { img = this.imageHook(abs); this.images.set(abs, img); }
      let w = o.w as number | undefined, h = o.h as number | undefined;
      if (w === undefined && h === undefined) { w = img.w; h = img.h; }
      else if (w === undefined) w = (h! * img.w) / img.h;
      else if (h === undefined) h = (w * img.h) / img.w;
      if (!(w! > 0 && h! > 0)) throw new VexError("image w and h must be > 0");
      const attrs: Record<string, string | number> = { x: x as number, y: y as number, width: w!, height: h!, href: img.href };
      if (o.pixel) attrs["image-rendering"] = "optimizeSpeed";
      const style: Style = {};
      for (const k of ["opacity", "glow", "blur"] as const) if (o[k] !== undefined) (style as Record<string, unknown>)[k] = o[k];
      if (o.blend !== undefined) {
        if (!BLENDS.includes(o.blend as string)) throw new VexError(`blend must be one of ${BLENDS.join(", ")}${didYouMean(String(o.blend), BLENDS)}`);
        style.blend = o.blend as string;
      }
      return { k: "shape", tag: "image", attrs, style, step: { label: `image(${JSON.stringify(src.replace(/^.*[\\/]/, ""))}, ${n(x as number)}, ${n(y as number)})`, loc } };
    });

    const define = (kind: AssetKind, name: unknown, rest: unknown[]) => at(kind, (loc) => {
      if (typeof name !== "string" || !name) throw new VexError(`${kind} needs a name string first`);
      const prev = this.assets.get(name) ?? this.groups.get(name);
      if (prev) throw new VexError(`'${name}' is already defined at ${prev.loc}`);
      const opts = (isPlain(rest[0]) ? rest.shift() : {}) as AssetOpts;
      checkKeys(`${kind} '${name}'`, opts, ASSET_OPTS[kind]);
      if (opts.outline !== undefined) color(opts.outline, "outline");
      if (opts.bg !== undefined) paintArg(opts.bg, "bg");
      if (opts.boil !== undefined && !(Number.isInteger(opts.boil) && opts.boil > 0)) throw new VexError(`boil must be a whole number of frames > 0, got ${JSON.stringify(opts.boil)}`);
      for (const [k, v] of Object.entries(opts.swap ?? {})) { color(k, "swap key"); color(v, "swap value"); }
      this.assets.set(name, { kind, name, opts, items: rest as Item[], pal: this.pal, loc });
      this.order.push(name);
    });
    env.sprite = (name: unknown, ...rest: unknown[]) => define("sprite", name, rest);
    env.scene = (name: unknown, ...rest: unknown[]) => define("scene", name, rest);
    env.anim = (name: unknown, ...rest: unknown[]) => define("anim", name, rest);
    env.group = (name: unknown, members: unknown) => at("group", (loc) => {
      if (typeof name !== "string" || !Array.isArray(members) || !members.every((m) => typeof m === "string"))
        throw new VexError('group("name", ["a", "b*", ...])');
      const prev = this.assets.get(name) ?? this.groups.get(name);
      if (prev) throw new VexError(`'${name}' is already defined at ${prev.loc}`);
      this.groups.set(name, { name, members, loc });
    });
    env.sheet = (name: unknown, entries: unknown, opts: unknown = {}) => at("sheet", (loc) => {
      if (typeof name !== "string" || !Array.isArray(entries) || !isPlain(opts)) throw new VexError('sheet("name", ["a", "b*"], { cols, pad, scale })');
      checkKeys(`sheet '${name}'`, opts, SHEET_OPTS);
      this.sheets.push({ name, entries, opts: opts as SheetDef["opts"], loc });
    });
    env.include = (path: unknown) => {
      if (typeof path !== "string") throw new VexError('include("other.vx.js")', this.callerLoc());
      if (!this.includeHook) throw new VexError("include() is not available here", this.callerLoc());
      this.includeHook(path);
    };
    env.rng = (seed?: number) => rng(seed);

    for (const [name, spec] of Object.entries(SHAPES)) {
      env[name] = (...args: unknown[]): ShapeNode => at(name, (loc) => {
        checkArgs(name, spec.args, args);
        const argc = spec.args.split(" ").length;
        const { style, ex } = styleArg(args[argc], spec.extra, !!spec.stroke);
        if (args.length > argc + 1) throw new VexError(`too many arguments; options go in the style object`);
        if (name === "text" && (style.ink || style.shade || style.hatch || style.tone || style.spot)) throw new VexError("ink, shade, hatch, tone and spot work on shapes, not text");
        return { k: "shape", ...shapeGeom(name, args, ex), style, step: { label: `${name}(${fmtArgs(args.slice(0, argc))})`, loc } };
      });
    }

    const ref = (kind: Ref["__ref"], allowed: string[], optsAt: number) => (...args: unknown[]): Ref => at(kind, (loc) => {
      const o = args[optsAt];
      if (o !== undefined) {
        if (!isPlain(o)) throw new VexError(`argument ${optsAt + 1} must be an options object`);
        checkKeys(kind, o, allowed);
        const sw = (o as UseOpts).swap;
        if (sw) for (const [k, v] of Object.entries(sw)) { color(k, "swap key"); color(v, "swap value"); }
      }
      return { __ref: kind, args, step: { label: `${kind}(${fmtArgs(args.slice(0, optsAt))})`, loc } };
    });
    const stamp = ref("stamp", USE_OPTS, 3);
    env.stamp = (...args: unknown[]) => {
      if (typeof args[0] !== "string") throw new VexError('stamp("name", x, y, { scale, rot, flip, anchor, swap, ... })', this.callerLoc());
      return stamp(...args);
    };
    env.scatter = ref("scatter", SCATTER_OPTS, 6);
    env.tile = ref("tile", TILE_OPTS, 5);
    env.tf = (o: unknown, ...items: unknown[]): Ref => at("tf", (loc) => {
      if (!isPlain(o)) throw new VexError("tf({ x, y, rot, scale, flip, origin, opacity, glow, blur, blend }, ...items)");
      checkKeys("tf", o, TF_OPTS);
      return { __ref: "tf", args: [o, ...items], step: { label: `tf(${fmtArgs([o])})`, loc } };
    });
    env.sym = (x: unknown, ...items: unknown[]): Ref => at("sym", (loc) => {
      if (typeof x !== "number") throw new VexError("sym(axisX, ...items): draws items plus their mirror image about x = axisX");
      return { __ref: "sym", args: [x, ...items], step: { label: `sym(${n(x)})`, loc } };
    });
    env.radial = (count: unknown, cx: unknown, cy: unknown, ...items: unknown[]): Ref => at("radial", (loc) => {
      if (!(Number.isInteger(count) && (count as number) >= 2) || typeof cx !== "number" || typeof cy !== "number")
        throw new VexError("radial(count, cx, cy, ...items): the items repeated count times around (cx, cy); count is a whole number >= 2");
      return { __ref: "radial", args: [count, cx, cy, ...items], step: { label: `radial(${count})`, loc } };
    });
    env.clip = (mask: unknown, ...items: unknown[]): Ref => at("clip", (loc) => {
      if (!isNode(mask) && !Array.isArray(mask)) throw new VexError("clip(maskShape, ...items): the mask is a shape like circle(...) or a list of shapes");
      return { __ref: "clip", args: [mask, ...items], step: { label: "clip(…)", loc } };
    });
    // ---- comic pages: panel layout, panels, speed lines
    const rectArg = (r: unknown, what: string): [number, number, number, number] => {
      if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => typeof v === "number" && Number.isFinite(v)) || r[2] <= 0 || r[3] <= 0)
        throw new VexError(`${what} must be [x, y, w, h] with w and h > 0`);
      return r as [number, number, number, number];
    };
    env.panels = (o: unknown) => at("panels", () => {
      if (!isPlain(o) || !Array.isArray(o.rows) || !o.rows.length) throw new VexError("panels({ w, h, margin, gutter, rows: [1, 2, [2, 1]], heights }): returns [x, y, w, h] per panel, row by row");
      checkKeys("panels", o, ["w", "h", "margin", "gutter", "rows", "heights"]);
      nums("panels", o, ["w", "h", "margin", "gutter"]);
      if (typeof o.w !== "number" || typeof o.h !== "number") throw new VexError("panels needs the page size: { w, h }");
      const margin = (o.margin as number) ?? 0, gutter = (o.gutter as number) ?? 8;
      const rows = (o.rows as unknown[]).map((r, i) => {
        const ws = typeof r === "number" ? Array.from({ length: r }, () => 1) : r;
        if (!Array.isArray(ws) || !ws.length || !ws.every((v) => typeof v === "number" && v > 0)) throw new VexError(`panels row ${i + 1} must be a panel count or a list of relative widths`);
        return ws as number[];
      });
      const hs = (o.heights as unknown[] | undefined) ?? rows.map(() => 1);
      if (!Array.isArray(hs) || hs.length !== rows.length || !hs.every((v) => typeof v === "number" && v > 0)) throw new VexError("panels heights must be one relative height per row");
      const W = o.w - 2 * margin, H = o.h - 2 * margin - gutter * (rows.length - 1), hsum = (hs as number[]).reduce((a, b) => a + b, 0);
      const out: [number, number, number, number][] = [];
      let y = margin;
      rows.forEach((ws, i) => {
        const rh = (H * (hs[i] as number)) / hsum, avail = W - gutter * (ws.length - 1), wsum = ws.reduce((a, b) => a + b, 0);
        let x = margin;
        for (const wr of ws) { const pw = (avail * wr) / wsum; out.push([x, y, pw, rh]); x += pw + gutter; }
        y += rh + gutter;
      });
      return out;
    });
    env.panel = (r: unknown, o: unknown, ...items: unknown[]): Ref => at("panel", () => {
      const [x, y, w, h] = rectArg(r, "panel's first argument");
      if (!isPlain(o)) throw new VexError("panel([x, y, w, h], { border, bw, bg, ink }, ...items): items in panel coordinates (0, 0 = its top-left), clipped to it");
      checkKeys("panel", o, ["border", "bw", "bg", "ink"]);
      nums("panel", o, ["bw"]);
      const E = env as Record<string, (...a: unknown[]) => unknown>;
      const border = (o.border as string | undefined) ?? (this.pal.has("k") ? "k" : "#000000"), bw = (o.bw as number | undefined) ?? 3;
      const frame = border === "none" ? null : o.ink
        ? E.rect(0, 0, w, h, { ink: { c: border, w: bw, wobble: bw * 0.25, ...(isPlain(o.ink) ? o.ink : {}) } })
        : E.rect(0, 0, w, h, { stroke: border, sw: bw, join: "miter" });
      return E.tf({ x, y }, E.clip(E.rect(0, 0, w, h, "#000000"), o.bg !== undefined ? E.rect(0, 0, w, h, paintArg(o.bg, "panel bg")) : null, ...items), frame) as Ref;
    });
    env.speedlines = (o: unknown) => at("speedlines", () => {
      if (!isPlain(o)) throw new VexError("speedlines({ area: [x, y, w, h], at: [cx, cy] | angle, count, w, inner, length, c, seed })");
      checkKeys("speedlines", o, ["area", "at", "angle", "count", "w", "inner", "length", "c", "seed", "opacity"]);
      const area = rectArg(o.area, "speedlines area");
      nums("speedlines", o, ["angle", "count", "w", "inner", "seed", "opacity"]);
      if (o.at !== undefined && !(Array.isArray(o.at) && o.at.length === 2 && o.at.every((v) => typeof v === "number"))) throw new VexError("speedlines at must be [cx, cy]");
      if ((o.at === undefined) === (o.angle === undefined)) throw new VexError("speedlines needs at: [cx, cy] (radial focus lines) or angle (parallel motion lines), not both");
      if (o.length !== undefined && !(Array.isArray(o.length) && o.length.length === 2 && o.length.every((v) => typeof v === "number" && v > 0 && v <= 1))) throw new VexError("speedlines length must be [min, max], fractions 0..1 of the area");
      const E = env as Record<string, (...a: unknown[]) => unknown>;
      const c = o.c !== undefined ? color(o.c, "speedlines c") : this.pal.has("k") ? "k" : "#000000";
      const d = speedLinesD(o as unknown as SpeedOpts);
      return E.clip(E.rect(...area, "#000000"), E.path(d, { fill: c, ...(o.opacity !== undefined ? { opacity: o.opacity } : {}) })) as Ref;
    });
    env.rig = (spec: unknown) => at("rig", () => makeRig(spec));
    env.particles = (o: unknown) => at("particles", () => {
      if (!isPlain(o)) throw new VexError("particles({ at | area, rate | burst, life, speed, angle, gravity, size, color, opacity, shape })");
      const po = checkParticles(o);
      for (const c of po.color ?? []) this.pal.resolve(c);
      const E = env as Record<string, (...a: unknown[]) => unknown>;
      return (f: FrameInfo) => simulate(po, f).filter((q) => q.size > 0.05 && q.opacity > 0.01).map((q) => {
        const st: Record<string, unknown> = { opacity: Math.min(1, q.opacity) };
        if (po.glow) st.glow = po.glow;
        if (po.blend) st.blend = po.blend;
        if (po.sprite) {
          const b = this.build(po.sprite);
          return E.stamp(po.sprite, q.x, q.y, { anchor: "center", scale: q.size / b.w, rot: q.rot, opacity: Math.min(1, q.opacity) });
        }
        switch (po.shape ?? "circle") {
          case "spark": {
            const len = Math.max(q.size, Math.hypot(q.vx, q.vy) * 2.2), m = Math.hypot(q.vx, q.vy) || 1;
            return E.line([q.x - (q.vx / m) * len, q.y - (q.vy / m) * len, q.x, q.y], { stroke: q.color, sw: Math.max(0.3, q.size * 0.45), ...st });
          }
          case "square": return E.tf({ x: q.x, y: q.y, rot: q.rot }, E.rect(-q.size / 2, -q.size / 2, q.size, q.size, { fill: q.color, ...st }));
          case "star": return E.star(q.x, q.y, 4, q.size, q.size * 0.35, { fill: q.color, rot: q.rot, ...st });
          case "ring": return E.circle(q.x, q.y, q.size, { stroke: q.color, sw: Math.max(0.4, q.size * 0.12), ...st });
          default: return E.circle(q.x, q.y, q.size / 2, { fill: q.color, ...st });
        }
      });
    });
    env.font = (name: unknown, o: unknown = {}) => at("font", (loc) => {
      if (typeof name !== "string" || !isPlain(o)) throw new VexError('font("name", { family, size, weight, chars, fill, outline, outlineColor, shadow, shadowColor }) or font("name", { glyphs: (ch) => "sprite", scale, spacing, baseline })');
      const keys = ["family", "size", "weight", "chars", "fill", "outline", "outlineColor", "shadow", "shadowColor", "glyphs", "scale", "spacing", "baseline"];
      checkKeys(`font '${name}'`, o, keys);
      if (o.glyphs !== undefined && typeof o.glyphs !== "function") throw new VexError(`font '${name}': glyphs must be a function (ch) => sprite name (or null to skip)`);
      nums(`font '${name}'`, o, ["scale", "spacing", "baseline"]);
      const fd: FontDef = { name, family: String(o.family ?? "Open Sans"), size: Number(o.size ?? 32), weight: Number(o.weight ?? 700),
        chars: String(o.chars ?? " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~"),
        fill: String(o.fill ?? "#ffffff"), outline: Number(o.outline ?? 0), outlineColor: String(o.outlineColor ?? "#000000"),
        shadow: (o.shadow as [number, number]) ?? [0, 0], shadowColor: String(o.shadowColor ?? "#000000"),
        glyphs: o.glyphs as FontDef["glyphs"], scale: Number(o.scale ?? 1), spacing: Number(o.spacing ?? 1), baseline: o.baseline as number | undefined, loc };
      for (const c of [fd.fill, fd.outlineColor, fd.shadowColor]) this.pal.resolve(c);
      this.fonts.push(fd);
    });
    env.platformer = (keys: unknown) => at("platformer", () => {
      const need = ["top", "topL", "topR", "fill", "fillL", "fillR"];
      if (!isPlain(keys) || !need.every((k) => typeof keys[k] === "string")) throw new VexError(`platformer({ ${need.join(", ")} }): tile keys from the tileset`);
      return platformer(keys as never);
    });
    env.tileset = (name: unknown, o: unknown) => at("tileset", (loc) => {
      if (typeof name !== "string" || !isPlain(o) || !isPlain(o.tiles) || typeof o.size !== "number")
        throw new VexError('tileset("name", { size: 32, tiles: { key: "sprite_name", ... } })');
      checkKeys(`tileset '${name}'`, o, ["size", "tiles"]);
      this.tilesets.set(name, { name, size: o.size, tiles: Object.entries(o.tiles as Record<string, string>), loc });
    });
    env.level = (name: unknown, o: unknown) => at("level", (loc) => {
      if (typeof name !== "string" || !isPlain(o)) throw new VexError('level("name", { tileset, map, legend, bg, seed, scale })');
      checkKeys(`level '${name}'`, o, ["tileset", "map", "legend", "bg", "seed", "scale"]);
      const ts = this.tilesets.get(String(o.tileset));
      if (!ts) throw new VexError(`unknown tileset '${o.tileset}'${didYouMean(String(o.tileset), this.tilesets.keys())}: define it with tileset() first`);
      const src = typeof o.map === "function" ? (o.map as (r: () => number) => unknown)(rng(Number(o.seed ?? 1))) : o.map;
      if (typeof src !== "string") throw new VexError("level map must be a string, or a function (rng) => string for generated levels");
      if (!isPlain(o.legend)) throw new VexError('level legend: { "#": "tile_key" | rule | { object: "sprite" } }');
      const legend = new Map<string, LegendEntry>();
      for (const [ch, v] of Object.entries(o.legend)) {
        if ([...ch].length !== 1) throw new VexError(`legend key '${ch}' must be one character`);
        if (typeof v === "string") legend.set(ch, { tile: v });
        else if (typeof v === "function") legend.set(ch, { terrain: v as never, group: ch });
        else if (isPlain(v) && typeof v.object === "string") legend.set(ch, { object: v.object, type: v.type as string | undefined, props: v.props as Record<string, unknown> | undefined });
        else if (isPlain(v) && typeof v.terrain === "function") legend.set(ch, { terrain: v.terrain as never, group: String(v.group ?? ch) });
        else throw new VexError(`legend '${ch}': a tile key, a rule function, { terrain, group } or { object: "sprite", type, props }`);
      }
      const grid = buildGrid(parseMap(src), legend, new Set(ts.tiles.map(([k]) => k)));
      const tileAsset = new Map(ts.tiles);
      const S = ts.size;
      // The level is also a scene, so it previews, exports and stamps like any vex asset.
      define("scene", name, [{ w: grid.cols * S, h: grid.rows * S, ...(o.bg !== undefined ? { bg: o.bg } : {}) },
        () => grid.tiles.flatMap((k, i) => {
          if (!k) return [];
          const asset = tileAsset.get(k)!, b = this.build(asset);
          return [(env.stamp as (...a: unknown[]) => unknown)(asset, (i % grid.cols) * S, Math.floor(i / grid.cols) * S, { scale: S / b.w })];
        }),
        () => grid.objects.map((ob) => (env.stamp as (...a: unknown[]) => unknown)(ob.name, ob.col * S + S / 2, (ob.row + 1) * S, { anchor: "bottom" }))]);
      this.levels.push({ name, tileset: ts, grid, scale: Number(o.scale ?? 1), loc });
    });
    // Spine export: each bone's art becomes a hidden part sprite (rest pose, full asset box).
    env.spine = (name: unknown, rg: unknown, o: unknown) => at("spine", (loc) => {
      if (typeof name !== "string" || !name) throw new VexError('spine("name", rig, { w, h, scale, outline, clips: { walk: { clip, frames, fps } } })');
      if (!isRig(rg)) throw new VexError("spine: the second argument must come from rig({ ... })");
      if (!isPlain(o)) throw new VexError("spine options must be an object");
      checkKeys(`spine '${name}'`, o, ["w", "h", "scale", "outline", "ow", "clips", "origin"]);
      if (!(typeof o.w === "number" && typeof o.h === "number")) throw new VexError(`spine '${name}' needs { w, h }: the rig's asset box`);
      const clips = (o.clips ?? {}) as Record<string, unknown>;
      if (!isPlain(clips)) throw new VexError("spine clips: { name: { clip, frames, fps } }");
      const parsed: SpineDef["clips"] = {};
      for (const [cn, c] of Object.entries(clips)) {
        if (!isPlain(c) || !(typeof c.frames === "number" && c.frames >= 1)) throw new VexError(`spine clip '${cn}': { clip, frames, fps }`);
        parsed[cn] = { clip: checkClip(rg, c.clip ?? {}), frames: c.frames, fps: Number(c.fps ?? 12) };
      }
      const parts: string[] = [];
      for (const [bone, b] of rg.bones) {
        if (!b.items.length) continue;
        const asset = `_spine_${name}_${bone}`;
        (env.sprite as (...a: unknown[]) => void)(asset, { w: o.w, h: o.h, ...(o.outline ? { outline: o.outline, ow: o.ow ?? 1.5 } : {}) }, ...b.items);
        parts.push(bone);
      }
      this.spines.push({ name, rig: rg, w: o.w, h: o.h, scale: Number(o.scale ?? 1), clips: parsed, parts, origin: (o.origin as [number, number]) ?? [o.w / 2, o.h], loc });
    });
    env.pose = (rg: unknown, clip: unknown = {}) => at("pose", () => {
      if (!isRig(rg)) throw new VexError("pose(rig, clip): the first argument must come from rig({ ... })");
      const c = checkClip(rg, clip);
      const tf = env.tf as (o: unknown, ...items: unknown[]) => Ref;
      // Each bone is drawn in z order, wrapped in its chain's transforms (root outermost), so the
      // hierarchy decides where it goes and z decides what is on top.
      return (f: FrameInfo) => rg.order.map((name) => {
        let item: unknown = rg.bones.get(name)!.items;
        const chain = rg.chains.get(name)!;
        for (let k = chain.length - 1; k >= 0; k--) {
          const b = rg.bones.get(chain[k])!, keys = c[chain[k]] ?? {};
          const rot = keys.rot ? sample(keys.rot, f) : 0;
          const mv = keys.move ? sample(keys.move, f) : [0, 0];
          const sc = keys.scale ? sample(keys.scale, f) : 1;
          if (!rot && !mv[0] && !mv[1] && sc === 1) continue;
          item = tf({ x: mv[0], y: mv[1], rot, scale: sc, origin: b.pivot }, item);
        }
        return item;
      });
    });
    return env;
  }

  // ---------------------------------------------------------------- resolving

  candidates(name: string, depth = 0): string[] {
    if (depth > 8) throw new VexError(`group nesting too deep at '${name}'`);
    const g = this.groups.get(name);
    if (g) return g.members.flatMap((m) => this.candidates(m, depth + 1));
    if (name.includes("*")) {
      const re = globRe(name);
      const list = this.order.filter((x) => re.test(x));
      if (!list.length) throw new VexError(`'${name}' matches no assets`);
      return list;
    }
    return [name];
  }

  /** Build an asset at a frame (anims wrap around; still assets ignore it). */
  build(name: string, frame = 0, seed = 0): Built {
    const def = this.assets.get(name);
    if (!def) {
      if (this.groups.has(name) || name.includes("*")) throw new VexError(`'${name}' is a group/glob: use it in stamp, scatter or tile`);
      throw new VexError(`unknown asset '${name}'${didYouMean(name, this.order)}`);
    }
    const count = frameCount(def);
    const f = ((Math.floor(frame) % count) + count) % count;
    const key = `${name}#${f}@${seed}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const failed = this.failed.get(key);
    if (failed) throw new VexError(`depends on '${name}', which failed`);
    if (this.building.has(name)) throw new VexError(`reference cycle through '${name}'`);
    this.building.add(name);
    try {
      const out = this.buildAsset(def, f, count, seed);
      this.cache.set(key, out);
      return out;
    } catch (e) {
      const err = wrap(e, (s) => this.locFromStack(s)).within(`${def.kind} '${name}'`, def.loc);
      this.failed.set(key, err);
      throw err;
    } finally {
      this.building.delete(name);
    }
  }

  /** Finished SVG document of an asset frame. */
  svg(name: string, frame = 0, scale?: number): string {
    const b = this.build(name, frame);
    const s = serialize(b.nodes, b.pal, idPrefix(name, b.frame));
    return svgDoc(b.box, s.defs, s.bodies.join(""), scale ?? b.scale);
  }

  exported(): string[] {
    return this.order.filter((x) => !x.startsWith("_"));
  }

  /** Expand a sheet's entries: globs match exported names, groups expand to members. */
  sheetNames(s: SheetDef): string[] {
    const out: string[] = [];
    const add = (x: string) => { if (!out.includes(x)) out.push(x); };
    for (const e of s.entries) {
      if (e.includes("*")) {
        const re = globRe(e);
        this.exported().filter((x) => re.test(x)).forEach(add);
      } else if (this.groups.has(e)) this.candidates(e).forEach(add);
      else add(e);
    }
    return out;
  }

  private buildAsset(def: AssetDef, frame: number, count: number, seed: number): Built {
    const { opts } = def;
    let w: number, h: number, box: Box, raw: Node[] = [], scale = opts.scale ?? 1;
    if (opts.base) {
      const b = this.build(opts.base, frame, seed);
      scale = opts.scale ?? b.scale;
      w = opts.w ?? b.w;
      h = opts.h ?? b.h;
      box = { ...b.box };
      raw.push({ k: "g", pal: b.pal, children: b.nodes, step: { label: `base '${opts.base}'`, loc: def.loc } });
    } else {
      if (!(typeof opts.w === "number" && opts.w > 0 && typeof opts.h === "number" && opts.h > 0))
        throw new VexError(`needs a size: ${def.kind}("${def.name}", { w: 32, h: 32 }, ...)`);
      w = opts.w;
      h = opts.h;
      box = { x: 0, y: 0, w, h };
    }
    const fi = frameInfo(frame, count, hash(def.name) + seed);
    if (opts.bg !== undefined) raw.push(this.withPats({ k: "shape", tag: "rect", attrs: { x: box.x, y: box.y, width: box.w, height: box.h }, style: { fill: opts.bg }, step: { label: "background", loc: def.loc } }, fi, seed));

    const steps: StepInfo[] = raw.map((r, i) => ({ label: r.step!.label, loc: r.step!.loc, end: i + 1 }));
    for (const item of def.items) {
      const got = this.expand(item, def, fi, seed, 0);
      raw.push(...got);
      const st = stepOf(item, def);
      steps.push({ label: st.label, loc: st.loc, end: raw.length });
    }

    let nodes = raw;
    const post: string[] = [];
    if (opts.boil && Math.floor(frame / opts.boil)) nodes = [{ k: "g", boil: Math.floor(frame / opts.boil), children: nodes }];
    if (opts.mx) {
      nodes = [{ k: "g", children: nodes }, { k: "g", tf: `matrix(-1 0 0 1 ${n(w)} 0)`, children: nodes }];
      post.push("mirror x");
    }
    if (opts.my) {
      nodes = [{ k: "g", children: nodes }, { k: "g", tf: `matrix(1 0 0 -1 0 ${n(h)})`, children: nodes }];
      post.push("mirror y");
    }
    if (opts.swap) { nodes = [{ k: "g", swap: opts.swap, children: nodes }]; post.push("swap"); }
    if (opts.flip || opts.rot) {
      const [fx, fy] = flipXY(opts.flip, def.name);
      nodes = [{ k: "g", tf: tfString(w / 2, h / 2, opts.rot ?? 0, fx, fy, w / 2, h / 2), children: nodes }];
      post.push([opts.flip && `flip ${opts.flip}`, opts.rot && `rot ${opts.rot}`].filter(Boolean).join(", "));
    }
    if (opts.outline) {
      const ow = opts.ow ?? 2;
      if (!(ow > 0)) throw new VexError(`ow (outline width) must be > 0`);
      nodes = [{ k: "g", silhouette: { color: opts.outline, ow }, children: nodes }];
      box = { x: box.x - ow, y: box.y - ow, w: box.w + 2 * ow, h: box.h + 2 * ow };
      post.push(`outline ${opts.outline}`);
    }
    return {
      name: def.name, kind: def.kind, w, h, box, nodes, raw, steps, post, pal: def.pal,
      frame, frames: count, fps: opts.fps ?? 12, scale,
    };
  }

  private expand(item: unknown, def: AssetDef, fi: FrameInfo, seed: number, depth: number): Node[] {
    if (depth > 64) throw new VexError("items nest too deep (a function returning itself?)");
    if (item === null || item === undefined || item === false) return [];
    if (Array.isArray(item)) return item.flatMap((v) => this.expand(v, def, fi, seed, depth + 1));
    if (typeof item === "function") {
      let got: unknown;
      try { got = item(fi); } catch (e) { throw wrap(e, (s) => this.locFromStack(s)); }
      return this.expand(got, def, fi, seed, depth + 1);
    }
    if (isNode(item)) return [item.k === "shape" ? this.withPats(item, fi, seed) : item];
    if (isRef(item)) {
      try { return this.resolve(item, def, fi, seed, depth); } catch (e) { throw wrap(e, (s) => this.locFromStack(s)).within(item.step.label, item.step.loc); }
    }
    const what = typeof item === "string" ? `the string ${JSON.stringify(item.slice(0, 20))}` : `a ${typeof item}`;
    throw new VexError(`item is ${what}; items are shapes, stamp/tf/clip/scatter/tile, functions (f) => items, or lists of those`, this.callerLoc());
  }

  /** A shape whose pattern paints are resolved to the pattern asset's nodes (the shape itself is left as written). */
  private withPats(s: ShapeNode, fi: FrameInfo, seed: number): ShapeNode {
    const f = s.style.fill, k = s.style.stroke;
    if (!(isPat(f) && !f.built) && !(isPat(k) && !k.built)) return s;
    const res = (p: Paint | undefined): Paint | undefined => (isPat(p) && !p.built ? this.resolvePat(p, fi, seed) : p);
    return { ...s, style: { ...s.style, fill: res(f), stroke: res(k) } };
  }

  private resolvePat(p: Pat, fi: FrameInfo, seed: number): Pat {
    const def = this.assets.get(p.name);
    if (!def) {
      if (this.groups.has(p.name) || p.name.includes("*")) throw new VexError(`pat: '${p.name}' is a group/glob; a pattern repeats one asset`);
      throw new VexError(`pat: unknown asset '${p.name}'${didYouMean(p.name, this.order)}`);
    }
    const frames = frameCount(def);
    const b = this.build(p.name, frames > 1 && fi.n > 1 ? Math.round((fi.i / fi.n) * frames) : 0, seed);
    return { ...p, built: { nodes: b.nodes, pal: b.pal, box: b.box } };
  }

  private resolve(r: Ref, def: AssetDef, fi: FrameInfo, seed: number, depth: number): Node[] {
    const a = r.args;
    if (r.__ref === "radial") {
      const [count, cx, cy] = a as [number, number, number];
      const kids = this.expand(a.slice(3), def, fi, seed, depth + 1);
      return Array.from({ length: count }, (_, i): Node => (i ? { k: "g", tf: `rotate(${n((360 * i) / count)} ${n(cx)} ${n(cy)})`, children: kids } : { k: "g", children: kids }));
    }
    if (r.__ref === "tf") {
      const o = a[0] as Record<string, unknown>;
      const [fx, fy] = flipXY(o.flip, "tf");
      const sc = o.scale ?? 1;
      const [sx, sy] = Array.isArray(sc) ? sc as [number, number] : [sc as number, sc as number];
      const [ox, oy] = (o.origin as [number, number] | undefined) ?? [0, 0];
      const style: Style = {};
      for (const k of ["opacity", "glow", "blur", "blend"] as const) if (o[k] !== undefined) (style as Record<string, unknown>)[k] = o[k];
      const tf = tfString(Number(o.x ?? 0) + ox, Number(o.y ?? 0) + oy, Number(o.rot ?? 0), sx * fx, sy * fy, ox, oy);
      return [{ k: "g", tf, style: Object.keys(style).length ? style : undefined, children: this.expand(a.slice(1), def, fi, seed, depth + 1) }];
    }
    if (r.__ref === "sym") {
      const ax = a[0] as number;
      const kids = this.expand(a.slice(1), def, fi, seed, depth + 1);
      return [{ k: "g", children: kids }, { k: "g", tf: `matrix(-1 0 0 1 ${n(2 * ax)} 0)`, children: kids }];
    }
    if (r.__ref === "clip") {
      const mask = this.expand(a[0], def, fi, seed, depth + 1);
      return [{ k: "clip", mask, children: this.expand(a.slice(1), def, fi, seed, depth + 1) }];
    }
    if (typeof a[0] !== "string") throw new VexError(`${r.__ref} needs an asset name first`);
    const name = a[0];
    const cands = this.candidates(name);
    const pick = (rr: () => number) => cands[Math.floor(rr() * cands.length) % cands.length];
    if (r.__ref === "stamp") {
      checkArgs("stamp", "name:s x:n y:n", a);
      const o = (a[3] ?? {}) as UseOpts;
      const rr = rng(hash(`${name}|${a[1]}|${a[2]}`) + seed);
      return [this.place(pick(rr), a[1] as number, a[2] as number, o, fi, seed, [0, 0], rr)];
    }
    if (r.__ref === "tile") {
      checkArgs("tile", "name:s x:n y:n cols:n rows:n", a);
      const o = (a[5] ?? {}) as UseOpts & { dx?: number; dy?: number };
      const first = this.build(cands[0], 0, seed);
      const dx = o.dx ?? first.w, dy = o.dy ?? first.h;
      const out: Node[] = [];
      for (let j = 0; j < (a[4] as number); j++)
        for (let i = 0; i < (a[3] as number); i++) {
          const rr = rng(hash(`${name}|${i}|${j}`) + seed);
          out.push(this.place(pick(rr), (a[1] as number) + i * dx, (a[2] as number) + j * dy, o, fi, seed, [0, 0], rr));
        }
      return out;
    }
    // scatter(name, x, y, w, h, count, opts)
    checkArgs("scatter", "name:s x:n y:n w:n h:n count:n", a);
    const [, x, y, w, h, count] = a as [string, number, number, number, number, number];
    const o = (a[6] ?? {}) as UseOpts & { scale?: number | [number, number]; rot?: number | [number, number] };
    const rr = rng(hash(`${name}|${x}|${y}|${w}|${h}|${count}`) + seed);
    const out: Node[] = [];
    for (let k = 0; k < count; k++) {
      const px = x + rr() * w, py = y + rr() * h;
      const s = pickRange(o.scale as number | [number, number] | undefined, rr, 1);
      const rot = pickRange(o.rot as number | [number, number] | undefined, rr, 0);
      const flip = o.flip ? ([o.flip.includes("x") && rr() < 0.5 && "x", o.flip.includes("y") && rr() < 0.5 && "y"].filter(Boolean).join("") || undefined) as UseOpts["flip"] : undefined;
      out.push(this.place(pick(rr), px, py, { ...o, scale: s, rot, flip, delay: (o.delay ?? 0) + k }, fi, seed, [0.5, 0.5], rr));
    }
    return out;
  }

  /** One placed copy of an asset as a transformed group. */
  private place(name: string, x: number, y: number, o: UseOpts, fi: FrameInfo, seed: number, dfltAnchor: [number, number], rr: () => number): Node {
    const target = this.assets.get(name);
    const tFrames = target ? frameCount(target) : 1;
    const frame = o.frame ?? (tFrames > 1 && fi.n > 1 ? Math.round((fi.i / fi.n) * tFrames) + (o.delay ?? 0) : o.delay ?? 0);
    const b = this.build(name, frame, o.seed ?? (seed ? seed + Math.floor(rr() * 1e6) : 0));
    const [ax, ay] = anchorOf(o.anchor, dfltAnchor);
    const sc = o.scale ?? 1;
    const [sx, sy] = Array.isArray(sc) ? sc : [sc, sc];
    const [fx, fy] = flipXY(o.flip, `stamp '${name}'`);
    return {
      k: "g", pal: b.pal, swap: o.swap,
      tf: tfString(x, y, o.rot ?? 0, sx * fx, sy * fy, ax * b.w, ay * b.h),
      style: o.opacity !== undefined ? { opacity: o.opacity } : undefined,
      children: b.nodes,
    };
  }
}

function frameCount(def: AssetDef): number {
  if (def.kind !== "anim") return 1;
  const f = def.opts.frames ?? 8;
  if (!(Number.isInteger(f) && f >= 1 && f <= 600)) throw new VexError(`anim '${def.name}': frames must be an integer 1..600`);
  return f;
}

function stepOf(item: unknown, def: AssetDef): Step {
  if (isNode(item) && item.step) return item.step;
  if (isRef(item)) return item.step;
  if (typeof item === "function") return { label: "ƒ(f)", loc: def.loc };
  if (Array.isArray(item)) return { label: `[${item.length} items]`, loc: def.loc };
  return { label: "item", loc: def.loc };
}

export interface FontDef {
  name: string;
  family: string;
  size: number;
  weight: number;
  chars: string;
  fill: string;
  outline: number;
  outlineColor: string;
  shadow: [number, number];
  shadowColor: string;
  /** Glyphs drawn as sprites: the sprite name for a character, or null to skip it. */
  glyphs?: (ch: string) => unknown;
  /** Glyph fonts: export pixels per unit, pixels between glyphs, baseline in units from the top of the glyph box. */
  scale: number;
  spacing: number;
  baseline?: number;
  loc?: string;
}

export interface TilesetDef {
  name: string;
  /** Tile size in level units. */
  size: number;
  /** [key, sprite name] in tile-id order. */
  tiles: [string, string][];
  loc?: string;
}

export interface LevelDef {
  name: string;
  tileset: TilesetDef;
  grid: LevelGrid;
  /** Export pixels per unit. */
  scale: number;
  loc?: string;
}

export interface SpineDef {
  name: string;
  rig: Rig;
  w: number;
  h: number;
  /** Export pixels per unit. */
  scale: number;
  clips: Record<string, { clip: Clip; frames: number; fps: number }>;
  /** Bones that draw something. */
  parts: string[];
  /** Skeleton origin in asset units (default: bottom center). */
  origin: [number, number];
  loc?: string;
}

export function idPrefix(name: string, frame: number): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_") + (frame ? `_f${frame}` : "") + "_";
}

function shapeGeom(name: string, a: unknown[], ex: Record<string, unknown>): Pick<ShapeNode, "tag" | "attrs" | "text" | "along"> {
  const num = (i: number) => a[i] as number;
  switch (name) {
    case "rect": {
      const attrs: Record<string, number> = { x: num(0), y: num(1), width: num(2), height: num(3) };
      if (ex.r !== undefined) attrs.rx = Number(ex.r);
      if (!(attrs.width >= 0 && attrs.height >= 0)) throw new VexError("rect: w and h must be >= 0");
      return { tag: "rect", attrs };
    }
    case "circle": return { tag: "circle", attrs: { cx: num(0), cy: num(1), r: num(2) } };
    case "ellipse": return { tag: "ellipse", attrs: { cx: num(0), cy: num(1), rx: num(2), ry: num(3) } };
    case "poly": return { tag: "path", attrs: { d: polyD(points(a[0], "poly", 3), true) } };
    case "line": return { tag: "path", attrs: { d: polyD(points(a[0], "line", 2), false) } };
    case "blob": return { tag: "path", attrs: { d: smoothD(points(a[0], "blob", 3), true, Number(ex.smooth ?? 1)) } };
    case "curve": return { tag: "path", attrs: { d: smoothD(points(a[0], "curve", 2), false, Number(ex.smooth ?? 1)) } };
    case "path": return { tag: "path", attrs: { d: a[0] as string } };
    case "star": return { tag: "path", attrs: { d: starD(num(0), num(1), num(2), num(3), num(4), Number(ex.rot ?? 0)) } };
    case "ngon": return { tag: "path", attrs: { d: starD(num(0), num(1), num(2), num(3), num(3), Number(ex.rot ?? 0)) } };
    case "arc": return { tag: "path", attrs: { d: arcD(num(0), num(1), num(2), num(3), num(4), !!ex.pie) } };
    case "text": {
      const attrs: Record<string, string | number> = { x: num(0), y: num(1), "font-size": Number(ex.size ?? 8), "font-family": String(ex.font ?? "sans-serif") };
      if (ex.anchor) attrs["text-anchor"] = String(ex.anchor);
      if (ex.weight) attrs["font-weight"] = String(ex.weight);
      if (ex.along !== undefined) {
        // text on a path: the curve through `along`, shifted by (x, y); `offset` 0..1 is where it starts
        const ps = points(ex.along, "text along", 2).map(([px, py]) => [px + num(0), py + num(1)] as [number, number]);
        const offset = Number(ex.offset ?? 0);
        if (!(offset >= 0 && offset <= 1)) throw new VexError("text offset must be 0..1 (where along the path the text starts)");
        delete attrs.x; delete attrs.y;
        return { tag: "text", attrs, text: a[2] as string, along: { d: smoothD(ps, false, Number(ex.smooth ?? 1)), offset } };
      }
      return { tag: "text", attrs, text: a[2] as string };
    }
  }
  throw new VexError(`unknown shape '${name}'`);
}
