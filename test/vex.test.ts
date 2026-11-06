import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { loadSource } from "../src/node/load.ts";
import { writeOutputs } from "../src/node/output.ts";
import { serve } from "../src/node/server.ts";

const svgOf = (src: string, name: string, frame = 0) => loadSource(src).svg(name, frame);
const throwsMsg = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: Error) => re.test(e.message));

test("palette keys resolve to hex; outline grows the drawn box", () => {
  const src = `pal({ k: "#102030", g: "#7bd36a" })
sprite("a", { w: 10, h: 8, outline: "k", ow: 2 }, circle(5, 4, 3, "g"))`;
  const svg = svgOf(src, "a");
  assert.match(svg, /viewBox="-2 -2 14 12"/);
  assert.match(svg, /<circle cx="5" cy="4" r="3" fill="#7bd36a"\/>/);
  // silhouette copy: outline color, stroke grown by 2 * ow
  assert.match(svg, /<circle cx="5" cy="4" r="3" fill="#102030" stroke="#102030" stroke-width="4"/);
});

test("variants and placement swaps compose, innermost first", () => {
  const src = `pal({ g: "#00ff00", r: "#ff0000", b: "#0000ff" })
sprite("_dot", { w: 4, h: 4 }, circle(2, 2, 2, "g"))
sprite("red", { w: 4, h: 4 }, stamp("_dot", 0, 0, { swap: { g: "r" } }))
sprite("blue", { base: "red", swap: { r: "b" } })`;
  assert.match(svgOf(src, "red"), /fill="#ff0000"/);
  const blue = svgOf(src, "blue");
  assert.match(blue, /fill="#0000ff"/);
  assert.doesNotMatch(blue, /#ff0000|#00ff00/);
});

test("8-digit hex splits into color + opacity; gradients and glow become defs", () => {
  const src = `sprite("a", { w: 10, h: 10 },
  rect(0, 0, 10, 10, "#11223380"),
  circle(5, 5, 3, { fill: rad(["#fff", "#000"]), glow: { r: 4, color: "#ff0" } }))`;
  const svg = svgOf(src, "a");
  assert.match(svg, /fill="#112233" fill-opacity="0.502"/);
  assert.match(svg, /<radialGradient id="a_\d+"/);
  assert.match(svg, /<filter id="a_\d+"[^>]*><feGaussianBlur in="SourceGraphic" stdDeviation="2" result="gl"\/><feFlood flood-color="#ffff00"\/>/);
});

test("variants inherit the base's export scale", () => {
  const p = loadSource(`sprite("a", { w: 4, h: 4, scale: 2 }, circle(2, 2, 2, "1"))\nsprite("b", { base: "a", swap: { "1": "2" } })`);
  assert.equal(p.build("b").scale, 2);
  assert.match(p.svg("b"), /width="8" height="8"/);
});

test("grain fills a shape with noise; blend sets the blend mode", () => {
  const svg = svgOf(`sprite("a", { w: 10, h: 10 }, rect(0, 0, 10, 10, { fill: "#000", grain: { freq: 2, seed: 3 }, blend: "overlay", opacity: 0.3 }))`, "a");
  assert.match(svg, /<feTurbulence type="fractalNoise" baseFrequency="2" numOctaves="2" seed="3"/);
  assert.match(svg, /style="mix-blend-mode:overlay"/);
  throwsMsg(() => loadSource(`sprite("a", { w: 4, h: 4 }, rect(0, 0, 4, 4, { fill: "1", blend: "screne" }))`), /did you mean 'screen'/);
});

test("sym and mx mirror about the axis", () => {
  const src = `sprite("a", { w: 20, h: 10 }, sym(10, circle(4, 5, 2, "1")))
sprite("b", { w: 20, h: 10, mx: true }, circle(4, 5, 2, "1"))`;
  assert.match(svgOf(src, "a"), /transform="matrix\(-1 0 0 1 20 0\)"/);
  assert.match(svgOf(src, "b"), /transform="matrix\(-1 0 0 1 20 0\)"/);
});

test("stamp anchors and scales about the anchor point", () => {
  const src = `sprite("t", { w: 10, h: 20 }, rect(0, 0, 10, 20, "1"))
sprite("s", { w: 50, h: 50 }, stamp("t", 25, 40, { anchor: "bottom", scale: 2 }))`;
  assert.match(svgOf(src, "s"), /transform="translate\(25 40\) scale\(2 2\) translate\(-5 -20\)"/);
});

test("anims: function items get the frame; placed anims follow it", () => {
  const src = `anim("blink", { w: 4, h: 4, frames: 2 }, (f) => circle(2, 2, f.i ? 1 : 2, "1"))
anim("host", { w: 8, h: 8, frames: 4 }, stamp("blink", 0, 0))`;
  const p = loadSource(src);
  assert.equal(p.build("blink").frames, 2);
  assert.match(p.svg("blink", 0), /r="2"/);
  assert.match(p.svg("blink", 1), /r="1"/);
  // host frame 2 of 4 -> blink frame 1 of 2
  assert.match(p.svg("host", 2), /r="1"/);
  assert.match(p.svg("host", 0), /r="2"/);
});

test("scatter is deterministic", () => {
  const src = `sprite("_p", { w: 2, h: 2 }, rect(0, 0, 2, 2, "1"))
sprite("s", { w: 50, h: 50 }, scatter("_p", 0, 0, 50, 50, 6, { rot: [0, 90], scale: [0.5, 1] }))`;
  const a = svgOf(src, "s"), b = svgOf(src, "s");
  assert.equal(a, b);
  assert.equal(a.match(/<rect /g)?.length, 6);
});

test("errors name the art-file location and suggest fixes", () => {
  throwsMsg(() => loadSource(`pal({ grass: "#0f0" })\nsprite("a", { w: 4, h: 4 },\n  circle(2, 2, 2, "gras"))`),
    /^art\.vx\.js:3:3: circle: unknown color 'gras' \(did you mean 'grass'\?\)/);
  throwsMsg(() => loadSource(`sprite("a", { w: 4, h: 4, outlin: "1" })`), /art\.vx\.js:1:1: sprite: sprite 'a': unknown option 'outlin' \(did you mean 'outline'\?\)/);
  throwsMsg(() => loadSource(`sprite("a", { w: 4, h: 4 }, circle(2, 2, "1"))`), /circle: argument 3 \(r\) must be a number/);
  const p = loadSource(`sprite("a", { w: 4, h: 4 }, stamp("slmie", 0, 0))\nsprite("slime", { w: 4, h: 4 }, circle(2, 2, 2, "1"))`);
  throwsMsg(() => p.build("a"), /sprite 'a' > stamp\("slmie", 0, 0\): unknown asset 'slmie' \(did you mean 'slime'\?\)/);
  const cyc = loadSource(`sprite("a", { w: 4, h: 4 }, stamp("b", 0, 0))\nsprite("b", { w: 4, h: 4 }, stamp("a", 0, 0))`);
  throwsMsg(() => cyc.build("a"), /reference cycle through 'a'/);
});

test("writeOutputs: SVG, PNGs at each scale, anim strip + JSON, atlas + JSON, previews", () => {
  const dir = mkdtempSync(join(tmpdir(), "vex-"));
  try {
    const src = `sprite("dot", { w: 10, h: 6, outline: "0", ow: 1 }, circle(5, 3, 3, "6"))
anim("pulse", { w: 8, h: 8, frames: 3, fps: 10 }, (f) => circle(4, 4, 2 + f.i, "4"))
sprite("bad", { w: 4, h: 4 }, stamp("missing", 0, 0))
sheet("atlas", ["dot", "pulse"], { pad: 1 })`;
    const r = writeOutputs(loadSource(src), dir, { scales: [1, 2] });
    assert.equal(r.errors.length, 1, "only the broken asset fails");
    assert.match(r.errors[0].message, /unknown asset 'missing'/);
    const size = (f: string) => { const b = readFileSync(join(dir, f)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
    assert.deepEqual(size("sprites/dot.png"), [12, 8]);
    assert.deepEqual(size("sprites/dot@2x.png"), [24, 16]);
    assert.match(readFileSync(join(dir, "sprites/dot.svg"), "utf8"), /^<svg /);
    assert.deepEqual(size("anims/pulse.png"), [24, 8]);
    const anim = JSON.parse(readFileSync(join(dir, "anims/pulse.json"), "utf8"));
    assert.deepEqual(Object.keys(anim.frames), ["pulse_0", "pulse_1", "pulse_2"]);
    assert.equal(anim.frames.pulse_1.duration, 100);
    const atlas = JSON.parse(readFileSync(join(dir, "atlas.json"), "utf8"));
    assert.deepEqual(Object.keys(atlas.frames), ["dot", "pulse_0", "pulse_1", "pulse_2"]);
    assert.deepEqual(atlas.meta.frameTags, [{ name: "pulse", from: 1, to: 3, direction: "forward" }]);
    assert.deepEqual(size("atlas.png"), [atlas.meta.size.w, atlas.meta.size.h]);
    // The PNG is a rendering of the SVG: center pixel of the dot is its fill color.
    const img = new Resvg(readFileSync(join(dir, "sprites/dot.svg"), "utf8")).render();
    const i = (4 * img.width + 6) * 4;
    assert.deepEqual([...img.pixels.subarray(i, i + 4)], [0x38, 0xb7, 0x64, 255]);
    for (const f of ["_preview/dot.png", "_preview/pulse.png", "_preview/atlas.png"]) assert.ok(size(f)[0] > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rig: keyframes interpolate with easing and hold outside their range", async () => {
  const { sample } = await import("../src/core/rig.ts");
  const fi = (i: number) => ({ i, n: 10, t: i / 10, sin: () => 0, cos: () => 0, rng: () => () => 0 });
  const tr: [number, number, string?][] = [[2, 0, "linear"], [6, 40], [8, 0, "step"], [9, 100]];
  assert.equal(sample(tr as never, fi(0)), 0);           // before the first key: hold
  assert.equal(sample(tr as never, fi(4)), 20);          // linear halfway
  assert.equal(sample(tr as never, fi(7)), 20);          // default inOut halfway is the midpoint
  assert.equal(sample(tr as never, fi(8.5)), 0);         // step holds until the next key
  assert.equal(sample(tr as never, fi(10)), 100);        // after the last key: hold
  assert.deepEqual(sample([[0, [0, 0]], [10, [10, -20]]] as never, fi(5)), [5, -10]);
});

test("rig: children follow their parent's pivot; z order is independent of the hierarchy", () => {
  const src = `const R = rig({
  arm: { pivot: [10, 10], z: 2, items: [rect(10, 10, 2, 10, "1")] },
  hand: { parent: "arm", pivot: [10, 20], z: 0, items: [circle(10, 22, 2, "2")] },
})
anim("a", { w: 40, h: 40, frames: 4 }, pose(R, { arm: { rot: [[0, 0], [4, 90]] }, hand: { rot: [[0, 30]] } }))`;
  const p = loadSource(src);
  const svg = p.svg("a", 2);
  // hand is drawn first (z 0) inside arm's transform (rotate 45 at frame 2 about 10,10), then its own
  assert.match(svg, /translate\(10 10\) rotate\(45\) translate\(-10 -10\)"><g transform="translate\(10 20\) rotate\(30\) translate\(-10 -20\)"><circle/);
  assert.ok(svg.indexOf("<circle") < svg.indexOf("<rect"), "hand (z 0) under arm (z 2)");
  // frame 0: no rotation on the arm, so no wrapper for it
  assert.doesNotMatch(p.svg("a", 0), /rotate\(0\)/);
});

test("rig: errors name the problem and suggest fixes", () => {
  throwsMsg(() => loadSource(`rig({ a: { pivot: [0, 0], parent: "b" }, b: { pivot: [0, 0], parent: "a" } })`), /bone cycle/);
  throwsMsg(() => loadSource(`rig({ arm: { pivot: [0, 0], parent: "torsso" }, torso: { pivot: [0, 0] } })`), /unknown parent 'torsso' \(did you mean 'torso'\?\)/);
  throwsMsg(() => loadSource(`pose(rig({ arm: { pivot: [0, 0] } }), { amr: { rot: [[0, 1]] } })`), /unknown bone 'amr' \(did you mean 'arm'\?\)/);
  throwsMsg(() => loadSource(`pose(rig({ arm: { pivot: [0, 0] } }), { arm: { rot: [[0, 1, "inOutt"], [2, 3]] } })`), /ease 'inOutt' \(did you mean 'inOut'\?\)/);
  throwsMsg(() => loadSource(`pose(rig({ arm: { pivot: [0, 0] } }), { arm: { rot: [[4, 1], [2, 3]] } })`), /key frames must increase/);
  throwsMsg(() => loadSource(`pose(rig({ arm: { pivot: [0, 0] } }), { arm: { spin: [[0, 1]] } })`), /unknown channel 'spin'/);
});

test("exported SVGs draw text as outlines; crops never touch the SVG", async () => {
  const { outlineText, pngCrop } = await import("../src/node/raster.ts");
  const p = loadSource(`sprite("t", { w: 60, h: 20 }, text(4, 15, "HI", { fill: "1", size: 12 }))
sprite("b", { w: 200, h: 100 }, circle(180, 80, 6, { fill: "1", blur: 3 }), rect(0, 0, 20, 20, "2"))`);
  const out = outlineText(p.svg("t"));
  assert.doesNotMatch(out, /<text/);
  assert.match(out, /<path/);
  // The blurred circle lies entirely outside the crop: the case that used to abort resvg.
  const png = pngCrop(p.svg("b", 0, 2), 2, { x: 0, y: 0, w: 20, h: 20 });
  assert.equal(png.readUInt32BE(16), 40);
  assert.equal(png.readUInt32BE(20), 40);
});

test("spine export: bones in y-up pixels, slots in draw order, clips baked per frame, atlas regions", async () => {
  const { writeSpine } = await import("../src/node/spine.ts");
  const p = loadSource(`const R = rig({
  body: { pivot: [10, 20], z: 1, items: [rect(5, 10, 10, 10, "1")] },
  arm: { parent: "body", pivot: [14, 12], z: 0, items: [rect(13, 12, 2, 8, "2")] },
})
spine("bot", R, { w: 20, h: 20, scale: 2, clips: { wave: { clip: { arm: { rot: [[0, 0, "linear"], [4, 90]] } }, frames: 4, fps: 8 } } })`);
  const dir = mkdtempSync(join(tmpdir(), "vex-"));
  try {
    writeSpine(p, p.spines[0], dir);
    const j = JSON.parse(readFileSync(join(dir, "spine/bot.json"), "utf8"));
    assert.match(j.skeleton.spine, /^4\.1\./);
    // origin is bottom center (10, 20): body pivot (10, 20) -> (0, 0); arm (14, 12) relative to body -> (4, 8) * scale
    assert.deepEqual(j.bones.map((b: { name: string; x?: number; y?: number }) => [b.name, b.x ?? 0, b.y ?? 0]), [["root", 0, 0], ["body", 0, 0], ["arm", 8, 16]]);
    assert.deepEqual(j.slots.map((s: { name: string }) => s.name), ["arm", "body"]);
    const rot = j.animations.wave.bones.arm.rotate;
    assert.equal(rot.length, 5);
    assert.deepEqual(rot[2], { time: 0.25, value: -45 });      // clockwise in vex -> counter-clockwise in Spine
    const atlas = readFileSync(join(dir, "spine/bot.atlas"), "utf8");
    assert.match(atlas, /^bot\.png\nsize:\d+,\d+\nfilter:Linear,Linear\n/);
    assert.match(atlas, /\narm\nbounds:\d+,\d+,6,17\n/);       // 2x8 units at scale 2 + 1 px margin (clipped at the box edge below)
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("levels: autotiling, objects, legend errors, Tiled export", async () => {
  const { writeLevel } = await import("../src/node/level.ts");
  const src = `for (const k of ["t", "tl", "tr", "f", "fl", "fr"]) sprite("_" + k, { w: 8, h: 8 }, rect(0, 0, 8, 8, "1"))
tileset("ts", { size: 8, tiles: { top: "_t", topL: "_tl", topR: "_tr", fill: "_f", fillL: "_fl", fillR: "_fr" } })
sprite("coin", { w: 4, h: 4 }, circle(2, 2, 2, "4"))
level("lv", { tileset: "ts", legend: { "#": platformer({ top: "top", topL: "topL", topR: "topR", fill: "fill", fillL: "fillL", fillR: "fillR" }),
  c: { object: "coin", type: "pickup", props: { value: 5 } } }, map: \`
  ..c..
  .###.
  .###.\` })`;
  const p = loadSource(src);
  const lv = p.levels[0];
  assert.deepEqual(lv.grid.tiles, [null, null, null, null, null, null, "topL", "top", "topR", null, null, "fillL", "fill", "fillR", null]);
  assert.deepEqual(JSON.parse(JSON.stringify(lv.grid.objects[0])), { id: 1, name: "coin", type: "pickup", col: 2, row: 0, props: { value: 5 } });   // props come from the sandbox realm
  assert.equal(p.build("lv").w, 40);
  const dir = mkdtempSync(join(tmpdir(), "vex-"));
  try {
    writeLevel(p, lv, dir);
    const j = JSON.parse(readFileSync(join(dir, "levels/lv.tmj"), "utf8"));
    assert.equal(j.layers[0].data.length, 15);
    assert.deepEqual(j.layers[0].data.slice(5, 10), [0, 2, 1, 3, 0]);        // gids follow tileset order
    assert.deepEqual([j.layers[1].objects[0].x, j.layers[1].objects[0].y, j.layers[1].objects[0].properties[0]], [16, 0, { name: "value", type: "int", value: 5 }]);
    assert.match(readFileSync(join(dir, "levels/lv.tmx"), "utf8"), /<data encoding="csv">\n0,0,0,0,0,\n0,2,1,3,0,/);
    const png = readFileSync(join(dir, "levels/ts.png"));
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [48, 8]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  throwsMsg(() => loadSource(src.replace("..c..", "..x..")), /map row 1, column 3: 'x' is not in the legend/);
  throwsMsg(() => loadSource(src.replace('tileset: "ts"', 'tileset: "tz"')), /unknown tileset 'tz' \(did you mean 'ts'\?\)/);
});

test("particles: deterministic, seamless loops, bursts start on time", async () => {
  const { simulate } = await import("../src/core/vfx.ts");
  const fi = (i: number, n: number) => ({ i, n, t: i / n, sin: () => 0, cos: () => 0, rng: () => () => 0 });
  const loop = { at: [0, 0] as [number, number], rate: 2, life: 10 as number, speed: 1 };
  // looping: frame 0 already shows particles from the previous cycle, and frame n would equal frame 0
  assert.ok(simulate(loop, fi(0, 24)).length >= 18);
  assert.deepEqual(simulate(loop, fi(5, 24)), simulate(loop, fi(5, 24)));
  const a = simulate(loop, fi(3, 24)).map((p) => [p.x, p.y]).sort(), b = simulate(loop, fi(27, 24)).map((p) => [p.x, p.y]).sort();
  assert.deepEqual(a, b);
  const burst = { at: [0, 0] as [number, number], burst: 5, start: 4, life: 6 as number, speed: 1, angle: 0 };
  assert.equal(simulate(burst, fi(3, 20)).length, 0);
  assert.equal(simulate(burst, fi(4, 20)).length, 5);
  assert.equal(simulate(burst, fi(11, 20)).length, 0);
  assert.ok(Math.abs(simulate(burst, fi(6, 20))[0].x - 2) < 1e-9);   // 2 frames at speed 1 along angle 0
  throwsMsg(() => loadSource(`particles({ at: [0, 0], rate: 1, shpe: "spark" })`), /unknown option 'shpe' \(did you mean 'shape'\?\)/);
  throwsMsg(() => loadSource(`particles({ at: [0, 0] })`), /needs a rate .* or a burst/);
});

test("9-slice keeps corners and stretches the middle; bitmap fonts write BMFont files", async () => {
  const { nineSlice } = await import("../src/node/output.ts");
  // 4x4 source: corners red, everything else blue; slice 1 px on every side
  const src = new Uint8Array(16 * 4);
  for (let i = 0; i < 16; i++) { const x = i % 4, y = Math.floor(i / 4), corner = (x === 0 || x === 3) && (y === 0 || y === 3); src.set(corner ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4); }
  const out = nineSlice(src, 4, 4, [1, 1, 1, 1], 10, 6);
  const px = (x: number, y: number) => [...out.subarray((y * 10 + x) * 4, (y * 10 + x) * 4 + 3)];
  assert.deepEqual(px(0, 0), [255, 0, 0]); assert.deepEqual(px(9, 5), [255, 0, 0]); assert.deepEqual(px(9, 0), [255, 0, 0]);
  assert.deepEqual(px(1, 0), [0, 0, 255]); assert.deepEqual(px(5, 3), [0, 0, 255]);

  const { writeFont } = await import("../src/node/font.ts");
  const p = loadSource(`font("f", { size: 20, chars: "AB i", outline: 1, outlineColor: "0" })`);
  const dir = mkdtempSync(join(tmpdir(), "vex-"));
  try {
    writeFont(p, p.fonts[0], dir);
    const xml = readFileSync(join(dir, "fonts/f.xml"), "utf8");
    assert.match(xml, /<chars count="4">/);
    const adv = (id: number) => Number(new RegExp(`<char id="${id}" [^>]*xadvance="(\\d+)"`).exec(xml)![1]);
    assert.ok(adv(32) > 0 && adv(32) < adv(65), "space has an advance, narrower than A");
    assert.ok(adv(105) < adv(66), "i is narrower than B");
    assert.match(readFileSync(join(dir, "fonts/f.fnt"), "utf8"), /^info face="Open Sans" size=20 .*\ncommon lineHeight=26 /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve: feedback from the viewer is written in asset units next to the outputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vex-fb-"));
  const file = join(dir, "a.vx.js");
  writeFileSync(file, `pal({ r: "#e0443e" })\nsprite("dot", { w: 10, h: 6 }, circle(5, 3, 3, "r"))`);
  const s = await serve(file, { port: 0, out: join(dir, "out"), log: () => {} });
  const post = (body: unknown) => fetch(s.url + "api/feedback", { method: "POST", body: JSON.stringify(body) });
  try {
    const r = await post({ name: "dot", comment: "rounder", notes: [{ x: 5, y: 3, text: "here" }],
      strokes: [{ color: "#E0443E", width: 0.5, points: [[1, 1], [4.256, 2]] }, { color: "javascript:x", width: 1, points: [[0, 0]] }] });
    assert.equal(r.status, 200);
    const fb = JSON.parse(readFileSync(join(dir, "out", "_feedback", "dot.json"), "utf8"));
    assert.equal(fb.comment, "rounder");
    assert.deepEqual(fb.notes, [{ n: 1, x: 5, y: 3, text: "here" }]);
    assert.equal(fb.strokes.length, 1, "invalid strokes are dropped");
    assert.deepEqual([fb.strokes[0].key, fb.strokes[0].kind, fb.strokes[0].points[1]], ["r", "palette", [4.26, 2]]);
    assert.ok(existsSync(join(dir, "out", "_feedback", "dot.marks.svg")) && existsSync(join(dir, "out", "_feedback", "dot.current.svg")));
    assert.equal((await post({ name: "../x" })).status, 400);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hand: ink is a filled band, the fill follows its wobble, and both are seeded", () => {
  const src = `pal({ k: "#100800", g: "#40a040" })
sprite("a", { w: 60, h: 60 }, circle(30, 30, 20, { fill: "g", ink: { c: "k", w: 4 } }))
sprite("b", { w: 60, h: 60 }, circle(30, 30, 20, { fill: "g", ink: { c: "k", w: 4, wobble: 0 } }))`;
  const a = svgOf(src, "a");
  // the wobbled outline is defined once and used by the fill
  const def = /<path id="(a_\d+)" d="M[^"]+Z"\/>/.exec(a);
  assert.ok(def, "outline def");
  assert.match(a, new RegExp(`<use href="#${def[1]}" fill="#40a040"/>`));
  // ink: outer ring + inner ring, filled with the ink color
  const ink = /<path d="(M[^"]+Z)(M[^"]+Z)" fill="#100800"\/>/.exec(a);
  assert.ok(ink, "ink band with two rings");
  assert.equal(a, svgOf(src, "a"), "same every build");
  // no wobble: the fill is the exact circle
  assert.match(svgOf(src, "b"), /<circle cx="30" cy="30" r="20" fill="#40a040"\/>/);
});

test("hand: ink weight follows the light, open lines taper, ink alone draws a line", () => {
  const p = loadSource(`sprite("a", { w: 60, h: 60 }, circle(30, 30, 20, { fill: "#fff", ink: { c: "#000", w: 6, wobble: 0, vary: 0, light: 0, weight: 0.5 } }))
sprite("l", { w: 60, h: 20 }, line([0, 10, 60, 10], { ink: { c: "#000", w: 4, wobble: 0, vary: 0, taper: 0.5 } }))`);
  const img = (name: string) => new Resvg(p.svg(name), { fitTo: { mode: "zoom", value: 4 } }).render();
  const px = (name: string, x: number, y: number) => { const i = img(name); return i.pixels[((y * 4) * i.width + x * 4) * 4 + 3]; };
  // light from above: down the middle column, the ring's bottom is heavier than its top
  const a = img("a"), col = (y0: number, y1: number) => {
    let c = 0;
    for (let y = y0 * 4; y < y1 * 4; y++) { const o = (y * a.width + 120) * 4; if (a.pixels[o + 3] > 128 && a.pixels[o + 1] < 128) c++; }
    return c;
  };
  assert.ok(col(40, 60) > col(0, 20) * 1.5, `shadow side is heavier (${col(40, 60)} vs ${col(0, 20)} px)`);
  // taper: full width in the middle, nothing at the very ends
  assert.ok(px("l", 30, 11) > 200);
  assert.ok(px("l", 1, 11) < 50);
});

test("hand: shade picks ramp colors, falls back without a ramp, and hatching follows the shadow", () => {
  const src = `pal({ g0: "#103010", g1: "#206020", g2: "#40a040", g3: "#90e090", q: "#808080" })
ramps("g0 g1 g2 g3")
sprite("a", { w: 40, h: 40 }, circle(20, 20, 15, { fill: "g2", shade: true, hatch: "g0" }))
sprite("b", { w: 40, h: 40 }, circle(20, 20, 15, { fill: "q", shade: { brush: 0 } }))`;
  const a = svgOf(src, "a");
  assert.match(a, /<rect [^>]*fill="#103010" mask="url\(#(a_\d+)\)"\/>/, "shadow two steps darker");
  assert.match(a, /fill="#90e090" mask=/, "highlight one step lighter");
  const shadowMask = /fill="#103010" mask="url\(#(a_\d+)\)"/.exec(a)![1];
  assert.match(a, new RegExp(`fill="url\\(#a_\\d+\\)" opacity="0.5" mask="url\\(#${shadowMask}\\)"`), "hatch masked by the shadow");
  assert.match(a, /<g clip-path="url\(#a_\d+\)">/);
  assert.match(a, /baseFrequency="0.05 0.45"/, "brush texture by default");
  const b = svgOf(src, "b");
  assert.match(b, /fill="#1a1030" opacity="0.5" mask=/, "fallback shadow without a ramp");
  assert.doesNotMatch(b, /baseFrequency/, "brush: 0 drops the texture");
});

test("hand: outlines include the ink, boil redraws every N frames, any path data flattens", () => {
  const src = `sprite("o", { w: 40, h: 40, outline: "#000", ow: 1 }, circle(20, 20, 12, { fill: "#fff", ink: "#333" }))
anim("b", { w: 40, h: 40, frames: 6, boil: 2 }, circle(20, 20, 12, { fill: "#fff", ink: "#333" }))
sprite("p", { w: 60, h: 60 }, path("M5 5h20v10H15V25q5 5 10 0t10 0s5 5 10 0c0 5 5 5 5 10a10 6 30 0 1 -20 0l-5 5z m30 -20 l5 0 0 5z", { fill: "#fff", ink: "#000", shade: true }))`;
  const p = loadSource(src);
  assert.match(p.svg("o"), /<path d="M[^"]+" fill="#000000" stroke="#000000" stroke-width="2"/, "ink grows the silhouette");
  const f = [0, 1, 2, 3, 4].map((i) => p.svg("b", i).replace(/b_(f\d+_)?/g, ""));
  assert.equal(f[0], f[1]);
  assert.notEqual(f[1], f[2]);
  assert.equal(f[2], f[3]);
  assert.notEqual(f[3], f[4]);
  const svg = p.svg("p");
  assert.equal((svg.match(/<path id="p_\d+" d="([^"]+)"/)![1].match(/M/g) ?? []).length, 2, "two subpaths");
  // renders at an odd scale and rotation (filter regions stay valid)
  for (const scale of [1, 3.7]) assert.ok(new Resvg(p.svg("p", 0, scale)).render().width > 0);
});

test("hand: errors name the problem", () => {
  const bad = (style: string, re: RegExp, shape = "circle(5, 5, 4, ") => throwsMsg(() => loadSource(`sprite("a", { w: 10, h: 10 }, ${shape}${style}))`), re);
  bad(`{ fill: "1", ink: { c: "0", wobbel: 1 } }`, /ink: unknown option 'wobbel'.*did you mean 'wobble'/);
  bad(`{ fill: "1", ink: { c: "0", w: "3" } }`, /ink w must be a number/);
  bad(`{ stroke: "1", shade: true }`, /shade needs a fill/);
  bad(`{ fill: "1", ink: "0", grain: {} }`, /grain can't be combined/);
  bad(`{ fill: "1", ink: "nope" }`, /unknown color 'nope'/);
  bad(`{ fill: "1", ink: "0" }`, /not text/, `text(1, 5, "hi", `);
  throwsMsg(() => loadSource(`anim("a", { w: 4, h: 4, boil: 0.5 }, circle(2, 2, 2, "1"))`), /boil must be a whole number/);
});

test("trace rebuilds an image exactly at smooth 0: holes stay open, diagonal touches stay apart", async () => {
  const { trace } = await import("../src/core/trace.ts");
  // 6x6: a red ring around a transparent hole, a blue pixel inside a gap, two greens touching diagonally
  const rows = [
    "rrrrr.",
    "r...rg",
    "r.b.g.",
    "r...r.",
    "rrrrr.",
    "......",
  ];
  const C: Record<string, number[]> = { r: [200, 40, 40, 255], g: [40, 200, 60, 255], b: [30, 60, 220, 255], ".": [0, 0, 0, 0] };
  const w = 6, h = 6, rgba = new Uint8Array(w * h * 4);
  rows.forEach((row, y) => [...row].forEach((ch, x) => rgba.set(C[ch], (y * w + x) * 4)));
  const t = trace(w, h, rgba, { colors: 3, name: "t" });
  assert.equal(t.colors.length, 3);
  const r = new Resvg(loadSource(t.source).svg("t", 0, 1)).render();
  for (let i = 0; i < w * h; i++) {
    const a = r.pixels[i * 4 + 3];
    assert.equal(a > 128, rgba[i * 4 + 3] > 0, `pixel ${i % w},${Math.floor(i / w)} coverage`);
    if (a > 128) for (let c = 0; c < 3; c++) assert.ok(Math.abs(r.pixels[i * 4 + c] - rgba[i * 4 + c]) <= 1, `pixel ${i} channel ${c}`);
  }
});

test("trace decodes premultiplied pixels back to straight color", async () => {
  const { readImage } = await import("../src/node/trace.ts");
  const dir = mkdtempSync(join(tmpdir(), "vex-trace-"));
  try {
    // a 1x1 PNG at half alpha, rendered by resvg itself
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#c86432" fill-opacity="0.5"/></svg>`;
    writeFileSync(join(dir, "a.png"), new Resvg(svg).render().asPng());
    const img = readImage(join(dir, "a.png"));
    assert.deepEqual([img.w, img.h], [1, 1]);
    for (const [i, v] of [0xc8, 0x64, 0x32].entries()) assert.ok(Math.abs(img.rgba[i] - v) <= 2, `channel ${i}`);
  } finally { rmSync(dir, { recursive: true }); }
});

test("--godot writes SpriteFrames beside strips and sheets at each scale; previews are .gdignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "vex-gd-"));
  try {
    const src = `sprite("dot", { w: 10, h: 6 }, circle(5, 3, 3, "6"))
anim("pulse", { w: 8, h: 8, frames: 3, fps: 10 }, (f) => circle(4, 4, 2 + f.i, "4"))
sheet("atlas", ["dot", "pulse"], { pad: 1 })`;
    const r = writeOutputs(loadSource(src), dir, { scales: [1, 2], godot: true });
    assert.deepEqual(r.errors, []);
    assert.ok(existsSync(join(dir, "_preview", ".gdignore")));
    const strip = readFileSync(join(dir, "anims", "pulse@2x.tres"), "utf8");
    assert.match(strip, /path="pulse@2x.png"/);
    assert.match(strip, /region = Rect2\(16, 0, 16, 16\)/);
    assert.match(strip, /"loop": true,\n"name": &"pulse",\n"speed": 10\n/);
    const atlas = readFileSync(join(dir, "atlas.tres"), "utf8");
    assert.match(atlas, /"name": &"dot"/);
    assert.equal((atlas.match(/AtlasTexture/g) ?? []).length, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
