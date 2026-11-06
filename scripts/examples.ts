// Builds every example (examples/*.vx.js -> examples/out, with --godot) and renders the README
// images to docs/examples. Fails if any example has an error. Run: npm run examples (part of npm run check).
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/node/cli.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "examples"), media = join(root, "docs", "examples");
const quiet = async (argv: string[]) => {
  const log = console.log, lines: string[] = [];
  console.log = (s: string) => lines.push(s);
  try { return { code: await main(argv), lines }; } finally { console.log = log; }
};
let failed = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".vx.js")).sort()) {
  const r = await quiet(["build", join(dir, f), "--godot"]);
  if (r.code !== 0) failed++;
  console.log(`${r.code === 0 ? "ok  " : "FAIL"} ${f} (${r.lines.length - 1} assets)`);
}
if (failed) { console.error(`${failed} example(s) failed`); process.exit(1); }

// [example, asset, scale, file in docs/examples]: the images the README shows
const shots: [string, string, number, string][] = [
  ["basics.vx.js", "meadow", 3, "meadow.png"],
  ["props.vx.js", "yard", 3, "yard.png"],
  ["comic.vx.js", "comic_page", 1, "comic_page.png"],
];
mkdirSync(media, { recursive: true });
for (const [file, name, scale, out] of shots) {
  const r = await quiet(["frame", join(dir, file), name, "--scale", String(scale), "--out", join(media, out)]);
  if (r.code !== 0) { console.error(`FAIL README image ${out}`); process.exit(1); }
}
copyFileSync(join(dir, "out", "items.png"), join(media, "items.png"));   // basics' atlas, as built
console.log(`README images -> ${media} (${shots.length + 1})`);
