import assert from "node:assert/strict";
import { test } from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { loadSource } from "../src/node/load.ts";

const throwsMsg = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: Error) => re.test(e.message));
/** Rendered RGBA of an asset at scale 1. */
const pixels = (src: string, name: string) => {
  const r = new Resvg(loadSource(src).svg(name, 0)).render();
  return { w: r.width, px: r.pixels };
};
const dark = (p: { w: number; px: Buffer }, x: number, y: number) => p.px[(y * p.w + x) * 4] < 80;

test("comic: panels() lays out rows by count or relative width, with margins and gutters", () => {
  const src = `const P = panels({ w: 220, h: 120, margin: 10, gutter: 10, rows: [1, [3, 1]], heights: [1, 2] })
sprite("probe", { w: 220, h: 120 }, P.map(([x, y, w, h]) => rect(x, y, w, h, "1")))`;
  const svg = loadSource(src).svg("probe", 0);
  // 90 units of rows split 1:2 -> 30 and 60; row 2's 190 units split 3:1
  assert.match(svg, /<rect x="10" y="10" width="200" height="30"/);
  assert.match(svg, /<rect x="10" y="50" width="142.5" height="60"/);
  assert.match(svg, /<rect x="162.5" y="50" width="47.5"/);
  throwsMsg(() => loadSource(`panels({ w: 100, h: 100, rows: [[2, 0]] })`), /panels row 1 must be a panel count or a list of relative widths/);
  throwsMsg(() => loadSource(`panels({ w: 100, h: 100, rows: [1, 1], heights: [1] })`), /one relative height per row/);
});

test("comic: panel() clips its items to the panel, in panel coordinates, under a border", () => {
  const src = `scene("page", { w: 100, h: 60, bg: "#ffffff" }, panel([10, 10, 40, 40], { bw: 2, border: "#000000" }, circle(0, 0, 30, "#ff0000")))`;
  const p = pixels(src, "page");
  const at = (x: number, y: number) => Array.from(p.px.subarray((y * p.w + x) * 4, (y * p.w + x) * 4 + 3));
  assert.deepEqual(at(20, 20), [255, 0, 0], "the circle at the panel's top-left fills its corner");
  assert.deepEqual(at(5, 5), [255, 255, 255], "nothing spills out of the panel");
  assert.ok(dark(p, 10, 30) && at(30, 10)[0] < 80, "the border is drawn on the edge");
  throwsMsg(() => loadSource(`sprite("s", { w: 9, h: 9 }, panel([0, 0, 9], {}))`), /panel's first argument must be \[x, y, w, h\]/);
  throwsMsg(() => loadSource(`sprite("s", { w: 9, h: 9 }, panel([0, 0, 9, 9], { border: "k", width: 2 }))`), /unknown option 'width'/);
});

test("comic: tone is a dot screen (flat pattern, or dots shrinking across the shape with fade)", () => {
  const flat = loadSource(`sprite("t", { w: 40, h: 40 }, rect(0, 0, 40, 40, { fill: "#ffffff", tone: { c: "#000000", gap: 5, dot: 0.6, angle: 30 } }))`).svg("t", 0);
  assert.match(flat, /<pattern id="[^"]+" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate\(30\)"><circle cx="2.5" cy="2.5" r="1.5"/);
  const fade = `sprite("f", { w: 80, h: 40 }, rect(0, 0, 80, 40, { fill: "#ffffff", tone: { c: "#000000", gap: 4, dot: 1, angle: 0, fade: 90 } }))`;
  const p = pixels(fade, "f");
  const ink = (x0: number) => { let s = 0; for (let y = 0; y < 40; y++) for (let x = x0; x < x0 + 16; x++) s += 255 - p.px[(y * p.w + x) * 4]; return s; };
  assert.ok(ink(0) > 3 * ink(64), `dense on the left, fading out to the right: ${ink(0)} vs ${ink(64)}`);
  const shaded = loadSource(`sprite("s", { w: 40, h: 40 }, circle(20, 20, 15, { fill: "#ffffff", shade: true, tone: "#000000" }))`).svg("s", 0);
  assert.match(shaded, /fill="url\(#[^"]+\)" opacity="1" mask="url\(#/, "with shade, the tone is only in the shadow");
  throwsMsg(() => loadSource(`sprite("s", { w: 9, h: 9 }, rect(0, 0, 9, 9, { fill: "#fff", tone: { c: "#000", gap: 0.2 } }))`), /tone gap must be at least 1 unit/);
});

test("comic: spot fills the far side solid black with a hard edge; depth follows the light", () => {
  const src = `pal({ k: "#000000", w: "#ffffff" })
scene("b", { w: 100, h: 40, bg: "w" }, rect(0, 0, 100, 40, { fill: "w", spot: { light: 90, depth: 0.3 } }))`;
  const p = pixels(src, "b");
  assert.ok(dark(p, 5, 20) && dark(p, 25, 20), "left 30% (away from a light on the right) is black");
  assert.ok(!dark(p, 40, 20) && !dark(p, 95, 20), "the lit side stays paper");
  throwsMsg(() => loadSource(`sprite("s", { w: 9, h: 9 }, rect(0, 0, 9, 9, { stroke: "#000", spot: true }))`), /spot needs a fill/);
});

test("comic: ink pressure shapes the width along the line; 'bend' thickens the turns", () => {
  const w = (pressure: string) => {
    const src = `scene("l", { w: 120, h: 20, bg: "#ffffff" }, line([10, 10, 110, 10], { ink: { c: "#000000", w: 8, wobble: 0, vary: 0, taper: 0, pressure: ${pressure} } }))`;
    const p = pixels(src, "l");
    return (x: number) => { let n = 0; for (let y = 0; y < 20; y++) if (dark(p, x, y)) n++; return n; };
  };
  const swell = w("[0.2, 1, 0.2]");
  assert.ok(swell(60) >= 7 && swell(14) <= 3, `thick in the middle, thin at the ends: ${swell(60)} vs ${swell(14)}`);
  const bend = (src: string) => loadSource(src).svg("c", 0).length;
  assert.ok(bend(`sprite("c", { w: 60, h: 60 }, curve([5, 55, 30, 5, 55, 55], { ink: { c: "#000", w: 6, pressure: "bend" } }))`) > 0);
  throwsMsg(() => loadSource(`sprite("s", { w: 9, h: 9 }, line([0, 0, 9, 9], { ink: { c: "#000", pressure: "hard" } }))`), /ink pressure must be a list of widths/);
});

test("comic: speed lines converge on a point or run parallel, clipped to their area, seeded", () => {
  const src = (o: string) => `scene("s", { w: 100, h: 60, bg: "#ffffff" }, speedlines({ area: [0, 0, 100, 60], c: "#000000", ${o} }))`;
  const radial = pixels(src("at: [50, 30], count: 80, w: 6, inner: 0.6"), "s");
  assert.ok(!dark(radial, 50, 30) && !dark(radial, 55, 32), "the focus stays clear");
  let edge = 0; for (let x = 0; x < 100; x++) if (dark(radial, x, 1)) edge++;
  assert.ok(edge > 10, `lines reach the edge: ${edge}`);
  assert.equal(loadSource(src("angle: 0, seed: 3")).svg("s", 0), loadSource(src("angle: 0, seed: 3")).svg("s", 0), "seeded");
  assert.notEqual(loadSource(src("angle: 0, seed: 3")).svg("s", 0), loadSource(src("angle: 0, seed: 4")).svg("s", 0));
  throwsMsg(() => loadSource(src("count: 5")), /needs at: \[cx, cy\] \(radial focus lines\) or angle/);
});
