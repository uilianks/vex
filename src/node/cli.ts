// vex command line.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pngCrop } from "./raster.ts";
import { VexError, wrap } from "../core/errors.ts";
import { loadProject } from "./load.ts";
import { writeOutputs } from "./output.ts";
import { serve } from "./server.ts";
import { traceFile } from "./trace.ts";

const USAGE = `vex — 2D vector game-asset DSL

  vex build <art.vx.js> [--out DIR] [--only a,b] [--scales 1,2] [--no-preview] [--no-grid] [--godot]
      Write SVG + PNG per asset (out/sprites, out/scenes, out/anims strips + JSON),
      atlases + JSON for sheets, and previews (out/_preview, with coordinate rulers). --godot also
      writes a Godot 4 SpriteFrames .tres beside every anim strip and sheet (one animation per tag).
  vex serve <art.vx.js> [--port 4322] [--out DIR | --no-out]
      Live viewer: rebuilds on save and replays each asset's drawing steps.
  vex svg   <art.vx.js> <name> [--frame N]
      Print an asset's SVG (exact geometry, cheap to read).
  vex frame <art.vx.js> <name> [--frame N] [--scale S] [--crop x,y,w,h] [--out FILE.png]
      Render one frame to PNG; --crop (asset units) cuts out a close-up in pixel space.
  vex list  <art.vx.js>
      List assets, groups and sheets with their source locations.
  vex trace <image.png> [--colors 32] [--smooth 0] [--name traced] [--scale S] [--out FILE.vx.js]
      Turn an image into vex source (palette + stacked color paths) and report how closely
      the traced art matches it. Default out: <image dir>/<image name>.vx.js.

Art files may be .js or .ts. Default out dir: <art file dir>/out.`;

interface Args {
  cmd?: string;
  file?: string;
  rest: string[];
  out?: string | false;
  only?: string[];
  scales?: number[];
  godot?: boolean;
  preview?: boolean;
  grid?: boolean;
  port?: number;
  frame?: number;
  scale?: number;
  crop?: { x: number; y: number; w: number; h: number };
  colors?: number;
  smooth?: number;
  name?: string;
}

function parse(argv: string[]): Args {
  const a: Args = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const val = () => {
      const x = argv[++i];
      if (x === undefined) throw new VexError(`${v} needs a value`);
      return x;
    };
    const num = (x: string) => {
      const k = Number(x);
      if (!(k > 0)) throw new VexError(`${v}: '${x}' is not a positive number`);
      return k;
    };
    if (v === "--out") a.out = val();
    else if (v === "--no-out") a.out = false;
    else if (v === "--only") a.only = val().split(",").map((s) => s.trim()).filter(Boolean);
    else if (v === "--scales") a.scales = val().split(",").map(num);
    else if (v === "--port") a.port = num(val());
    else if (v === "--frame") a.frame = Number(val());
    else if (v === "--scale") a.scale = num(val());
    else if (v === "--crop") {
      const c = val().split(",").map(Number);
      if (c.length !== 4 || c.some((x) => !Number.isFinite(x)) || !(c[2] > 0 && c[3] > 0)) throw new VexError("--crop must be x,y,w,h in asset units");
      a.crop = { x: c[0], y: c[1], w: c[2], h: c[3] };
    }
    else if (v === "--colors") a.colors = num(val());
    else if (v === "--smooth") {
      a.smooth = Number(val());
      if (!(a.smooth >= 0 && a.smooth <= 1)) throw new VexError("--smooth must be between 0 and 1");
    }
    else if (v === "--name") a.name = val();
    else if (v === "--no-preview") a.preview = false;
    else if (v === "--godot") a.godot = true;
    else if (v === "--no-grid") a.grid = false;
    else if (v === "-h" || v === "--help") a.cmd = "help";
    else if (v.startsWith("--")) throw new VexError(`unknown flag ${v}\n\n${USAGE}`);
    else if (!a.cmd) a.cmd = v;
    else if (!a.file) a.file = v;
    else a.rest.push(v);
  }
  return a;
}

export async function main(argv: string[]): Promise<number> {
  let a: Args;
  try { a = parse(argv); } catch (e) { console.error(wrap(e).message); return 2; }
  if (!a.cmd || a.cmd === "help" || !a.file) {
    console.log(USAGE);
    return a.cmd === "help" ? 0 : 2;
  }
  const file = resolve(a.file);
  const outDir = typeof a.out === "string" ? resolve(a.out) : join(dirname(file), "out");
  try {
    switch (a.cmd) {
      case "build": {
        const p = loadProject(file);
        const r = writeOutputs(p, outDir, { only: a.only, preview: a.preview, scales: a.scales, grid: a.grid, godot: a.godot });
        for (const l of r.lines) console.log(l);
        for (const e of r.errors) console.error("error: " + e.message);
        console.log(`-> ${outDir}${r.errors.length ? ` (${r.errors.length} error${r.errors.length > 1 ? "s" : ""})` : ""}`);
        return r.errors.length ? 1 : 0;
      }
      case "svg": {
        const name = a.rest[0];
        if (!name) throw new VexError("svg needs an asset name: vex svg <file> <name>");
        console.log(loadProject(file).svg(name, a.frame ?? 0, 1));
        return 0;
      }
      case "frame": {
        const name = a.rest[0];
        if (!name) throw new VexError("frame needs an asset name: vex frame <file> <name>");
        const p = loadProject(file);
        const b = p.build(name, a.frame ?? 0), s = a.scale ?? b.scale;
        const out = typeof a.out === "string" ? resolve(a.out) : join(outDir, "frames", `${name}_${b.frame}.png`);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, pngCrop(p.svg(name, a.frame ?? 0, s), s, a.crop, b.box));
        console.log(`frame ${name} #${b.frame} -> ${out}`);
        return 0;
      }
      case "list": {
        const p = loadProject(file);
        for (const x of p.order) {
          const d = p.assets.get(x)!;
          console.log(`${d.kind.padEnd(6)} ${x.padEnd(24)} ${d.loc ?? ""}`);
        }
        for (const g of p.groups.values()) console.log(`${"group".padEnd(6)} ${g.name.padEnd(24)} ${g.loc ?? ""}  [${g.members.join(" ")}]`);
        for (const s of p.sheets) console.log(`${"sheet".padEnd(6)} ${s.name.padEnd(24)} ${s.loc ?? ""}`);
        return 0;
      }
      case "trace": {
        const out = typeof a.out === "string" ? resolve(a.out) : file.replace(/\.[^./]+$/, "") + ".vx.js";
        const { traced, fit } = traceFile(file, { colors: a.colors, smooth: a.smooth, name: a.name, scale: a.scale, from: a.file });
        writeFileSync(out, traced.source);
        console.log(`trace ${traced.w}x${traced.h}: ${traced.colors.length} colors, ${(traced.source.length / 1024).toFixed(0)} KB -> ${out}`);
        console.log(`fidelity: mean error ${fit.meanError.toFixed(1)}/255, ${(fit.close * 100).toFixed(1)}% of pixels within 16, ${fit.silhouetteMiss} silhouette pixels off`);
        return 0;
      }
      case "serve": {
        const s = await serve(file, { port: a.port, out: a.out === false ? false : outDir });
        console.log(`vex live viewer: ${s.url}  (watching ${file}; Ctrl+C to stop)`);
        return await new Promise<number>(() => {});
      }
      default:
        console.error(`unknown command '${a.cmd}'\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    console.error("error: " + wrap(e).message);
    return 1;
  }
}
