// A comic page in ink: panels() lays out the page, panel() clips each one, and the shapes are inked
// with pressure, filled with screentone (flat and gradient), spot blacks on the shadow side, speed
// lines and lettered balloons. Black ink on warm paper; lettering uses the Caveat font if installed.
pal({ k: "#16130f", p: "#f4ecda", w: "#fffaf0", g: "#8d8576" })
const INK = (w = 3, more = {}) => ({ c: "k", w, ...more })
const FONT = { font: "Caveat", weight: 700, anchor: "middle" }

// A speech balloon: an ellipse with a tail toward (tx, ty), as one shape so the ink runs round both.
const balloon = (cx, cy, rx, ry, tx, ty, lines, size = 19) => {
  const at = Math.atan2(ty - cy, tx - cx), pts = []
  for (let i = 0; i < 48; i++) {
    const a = at + 0.22 + (i / 48) * (2 * Math.PI - 0.44)
    pts.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry)
  }
  pts.push(tx, ty)
  return [poly(pts, { fill: "w", ink: INK(2.5, { wobble: 0.6 }) }),
    lines.map((t, i) => text(cx, cy + (i - (lines.length - 1) / 2) * size * 1.05 + size * 0.35, t, { fill: "k", size, ...FONT }))]
}
const caption = (x, y, w, lines) => [rect(x, y, w, lines.length * 19 + 12, { fill: "#fbefc8", ink: INK(2, { wobble: 0.4 }) }),
  lines.map((t, i) => text(x + w / 2, y + 22 + i * 19, t, { fill: "k", size: 18, ...FONT }))]

const P = panels({ w: 600, h: 860, margin: 20, gutter: 12, rows: [1, [3, 2], 1], heights: [1.05, 1, 1] })

// 1. The city at night: a gradient-tone sky, the moon, and buildings with spot blacks.
const buildings = [[0, 150, 70], [64, 120, 60], [118, 175, 80], [190, 95, 54], [238, 140, 92], [324, 105, 66], [384, 160, 78], [456, 128, 104]]
const city = [
  rect(0, 0, 560, 274, { fill: "p", tone: { c: "k", gap: 5, dot: 1.05, fade: 180 } }),
  circle(450, 74, 36, { fill: "w", ink: INK(3) }),
  buildings.map(([x, top, w], i) => [
    rect(x, top, w, 274 - top + 10, { fill: "p", ink: INK(3, { pressure: "bend" }), spot: { light: 90, depth: 0.4 } }),
    Array.from({ length: Math.floor((274 - top - 20) / 22) }, (_, r) => Array.from({ length: Math.floor((w - 16) / 16) }, (_, c) =>
      (r * 7 + c * 3 + i) % 5 === 0 ? rect(x + 10 + c * 16, top + 14 + r * 22, 7, 10, { fill: "w", ink: INK(1.2, { wobble: 0.2 }) }) : null)),
  ]),
  // a water tower on the tallest roof
  line([206, 95, 202, 70], { ink: INK(2.5) }), line([232, 95, 236, 70], { ink: INK(2.5) }),
  rect(196, 38, 46, 34, { fill: "p", r: 3, ink: INK(3), spot: { light: 90, depth: 0.4 } }),
  poly([192, 40, 219, 22, 246, 40], { fill: "p", ink: INK(3), spot: { light: 90, depth: 0.4 } }),
  caption(14, 14, 238, ["THE CITY NEVER SLEEPS.", "NEITHER DO I."]),
]

// 2. Close-up: radial speed lines push in on the courier's face.
const face = [
  rect(0, 0, 329, 261, { fill: "w" }),
  speedlines({ area: [0, 0, 329, 261], at: [164, 140], count: 110, w: 7, inner: 0.62, seed: 4 }),
  blob([164, 40, 238, 88, 252, 180, 214, 262, 114, 262, 76, 180, 90, 88], { fill: "p", tone: { c: "k", gap: 4, dot: 0.5 }, ink: INK(5, { pressure: "bend" }), spot: { light: 300, depth: 0.22 } }),
  ellipse(164, 160, 50, 60, { fill: "p", ink: INK(3.5, { pressure: "bend" }), spot: { light: 300, depth: 0.16 } }),
  sym(164,
    curve([128, 142, 142, 136, 156, 143], { ink: INK(5, { pressure: [0.2, 1, 0.5], taper: 0.1 }) }),           // brow, pulled down
    curve([132, 156, 142, 152, 152, 157], { ink: INK(3, { pressure: [0.3, 1, 0.3] }) }),                         // lid
    circle(143, 159, 3, "k")),
  curve([168, 160, 172, 180, 164, 184], { ink: INK(2.5, { pressure: [0.2, 1, 0.6] }) }),                        // nose
  curve([148, 200, 164, 197, 180, 201], { ink: INK(3, { pressure: [0.3, 1, 0.3] }) }),                          // mouth
  caption(10, 214, 170, ["NINE MINUTES LEFT."]),
]

// 3. The parcel: parallel motion lines and a sound effect along a curve.
const parcel = [
  rect(0, 0, 220, 261, { fill: "p" }),
  speedlines({ area: [0, 96, 104, 84], angle: -14, count: 16, w: 4, length: [0.5, 0.95], seed: 2 }),
  tf({ x: 128, y: 136, rot: -14 },
    rect(-46, -32, 92, 64, { fill: "p", r: 2, ink: INK(3.5, { pressure: "bend" }), spot: { light: 315, depth: 0.3 }, tone: { c: "k", gap: 4, dot: 0.45, angle: 30 } }),
    rect(-8, -32, 16, 64, { fill: "w", ink: INK(1.5, { wobble: 0.3 }) }),
    rect(-38, -22, 24, 14, { fill: "w", ink: INK(1.2, { wobble: 0.2 }) })),
  text(0, 0, "WHOOSH!", { fill: "k", size: 40, font: "Caveat", weight: 700, along: [16, 62, 110, 30, 206, 52] }),
]

// 4. The leap: a black silhouette between two roofs, a balloon, and the moon behind.
const leap = [
  rect(0, 0, 560, 261, { fill: "p", tone: { c: "k", gap: 5, dot: 1.05, fade: 180, angle: 30 } }),
  circle(470, 70, 30, { fill: "w", ink: INK(2.5) }),
  speedlines({ area: [150, 110, 130, 90], angle: -24, count: 14, w: 3.5, length: [0.4, 0.8], seed: 7 }),
  poly([0, 196, 236, 214, 236, 270, 0, 270], { fill: "k", ink: INK(3) }),
  poly([372, 186, 560, 176, 560, 270, 372, 270], { fill: "k", ink: INK(3) }),
  tf({ x: 322, y: 118, rot: -18, scale: 1.5 },
    curve([-6, 14, -34, 22, -54, 44], { ink: INK(9, { pressure: [1, 0.8, 0.5], taper: 0.05 }) }),   // back leg
    curve([6, 16, 30, 26, 36, 50], { ink: INK(9, { pressure: [1, 0.8, 0.5], taper: 0.05 }) }),     // front leg
    curve([-8, -18, -34, -30, -50, -18], { ink: INK(7, { pressure: [1, 0.7, 0.4], taper: 0.05 }) }),  // arms
    curve([8, -18, 32, -34, 46, -50], { ink: INK(7, { pressure: [1, 0.7, 0.4], taper: 0.05 }) }),
    ellipse(0, 0, 14, 24, { fill: "k", ink: INK(2) }),
    circle(6, -32, 11, { fill: "k", ink: INK(2) }),
    rect(-26, -20, 18, 22, { fill: "k", r: 3, ink: INK(2) })),                                     // the bag
  balloon(130, 64, 112, 40, 268, 104, ["LAST DELIVERY", "OF THE NIGHT."]),
]

scene("comic_page", { w: 600, h: 860, bg: "p" },
  panel(P[0], { ink: true }, city),
  panel(P[1], { ink: true }, face),
  panel(P[2], { ink: true }, parcel),
  panel(P[3], { ink: true }, leap))
