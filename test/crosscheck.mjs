// Holds the two implementations of the instruction set against each other.
//
//   node test/crosscheck.mjs      (or: npm test, which runs it after the unit checks)
//
// For each graph: compile it, render every pixel with the TypeScript interpreter the editor
// previews with, pack the same Program to a .bin, render that with the C++ VM the ESP32
// runs, and compare. This is the test that makes "what you see is what the head does" a
// claim rather than a hope - a drifting opcode shows up here as a wrong pixel.
//
// Needs a host C++ compiler. Without one it skips rather than fails, so the JS-only checks
// still run on a machine with no toolchain.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), "protoshade-"));

const cxx = process.env.CXX || "g++";
if (spawnSync(cxx, ["--version"]).status !== 0) {
  console.log(`crosscheck: skipped, no ${cxx} on this machine (set CXX to a C++ compiler to run it)`);
  process.exit(0);
}

// One bundle so both halves of the pipeline share a module instance, same as the browser.
const entry = join(work, "entry.ts");
writeFileSync(
  entry,
  `export { compile, Runner } from ${JSON.stringify(join(root, "web/graph.ts"))};\n` +
    `export { pack } from ${JSON.stringify(join(root, "web/pack.ts"))};\n`,
);
const bundle = join(work, "bundle.mjs");
await esbuild.build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "esm", logLevel: "warning" });
const { compile, Runner, pack } = await import(pathToFileURL(bundle));

const renderer = join(work, "render");
execFileSync(cxx, [
  "-std=c++17",
  "-O2",
  "-Wall",
  join(root, "test/render.cpp"),
  join(root, "src/ProtoShadeRuntime.cpp"),
  "-o",
  renderer,
]);

/** Graph literal: nodes are [id, type, props, ...inputLinkIds], links are id -> [from, slot]. */
function graph(nodes, links) {
  return {
    _nodes: nodes.map(([id, type, properties, ...inputs]) => ({
      id,
      type,
      properties,
      inputs: inputs.map((link) => ({ link })),
    })),
    links: Object.fromEntries(
      Object.entries(links).map(([id, [origin_id, origin_slot]]) => [id, { origin_id, origin_slot }]),
    ),
  };
}

const out = (id, link) => [id, "output/led", { brightness: 1 }, link];

/** An image whose pixels vary in all four channels, so a wrong swizzle cannot hide. */
function testImage(w, h, opaque) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = (i * 37) % 256;
    data[i * 4 + 1] = (i * 91) % 256;
    data[i * 4 + 2] = (i * 13) % 256;
    data[i * 4 + 3] = opaque ? 255 : (i * 57) % 256;
  }
  return { w, h, data };
}

const W = 17; // odd and not a power of two, so nothing divides evenly by accident
const H = 9;

/** Renders with the TypeScript interpreter: the exact loop main.ts previews with. */
function renderJs(program, ms, sensors) {
  const runner = new Runner(program);
  const env = { x: 0, y: 0, u: 0, v: 0, w: W, h: H, t: ms / 1000, frame: 0, sensors };
  const colour = [0, 0, 0, 1];
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0, p = 0; y < H; y++) {
    for (let x = 0; x < W; x++, p += 3) {
      env.x = x;
      env.y = y;
      env.u = (x + 0.5) / W;
      env.v = (y + 0.5) / H;
      runner.run(env, colour);
      buf[p] = Math.round(colour[0] * 255);
      buf[p + 1] = Math.round(colour[1] * 255);
      buf[p + 2] = Math.round(colour[2] * 255);
    }
  }
  return buf;
}

let cases = 0;
let worst = 0;
let exact = 0;
let pixels = 0;

function check(name, g, images = new Map(), ms = 1234, sensors = undefined) {
  const result = compile(g, images, W, H);
  assert.ok(result.ok, `${name}: ${result.ok ? "" : result.reason}`);

  const js = renderJs(result.program, ms, sensors);
  const bin = join(work, "case.bin");
  writeFileSync(bin, Buffer.from(pack(result.program)));
  const args = [bin, String(W), String(H), String(ms), ...(sensors ?? []).map(String)];
  const cpp = execFileSync(renderer, args, { maxBuffer: 1 << 24 });

  assert.equal(cpp.length, js.length, `${name}: size mismatch`);
  for (let i = 0; i < js.length; i++) {
    const d = Math.abs(js[i] - cpp[i]);
    worst = Math.max(worst, d);
    if (d === 0) exact++;
    // One level of 255 is the float-vs-double rounding of the last bit, invisible on an
    // LED. Anything larger means the two implementations actually disagree.
    assert.ok(d <= 1, `${name}: byte ${i} differs, js=${js[i]} cpp=${cpp[i]}`);
  }
  pixels += js.length;
  cases++;
}

// --- the graph the editor opens with ----------------------------------------
check(
  "default",
  graph(
    [
      [1, "input/coordinates", {}],
      [2, "vector/separate", {}, 10],
      [3, "input/time", { speed: 0.2 }],
      [4, "math/math", { op: "add", a: 0, b: 1 }, 20, 30],
      [5, "color/hsv", { hue: 0, sat: 1, val: 1, alpha: 1 }, 40, null, null, null],
      out(6, 50),
    ],
    { 10: [1, 0], 20: [2, 0], 30: [3, 0], 40: [4, 0], 50: [5, 0] },
  ),
);

// --- every math op, fed a coordinate so the inputs actually vary --------------
for (const op of [
  "add", "subtract", "multiply", "divide", "power", "modulo", "minimum", "maximum",
  "greater than", "less than", "arctan2", "sine", "cosine", "absolute", "floor", "ceil",
  "round", "fraction", "sqrt", "clamp", "smoothstep",
]) {
  check(
    `math:${op}`,
    graph(
      [
        [1, "input/coordinates", {}],
        // Centered runs -2..2 here, so negatives, zero and values past 1 all get exercised.
        [2, "math/math", { op, a: 0, b: 0.37 }, 10, null],
        out(3, 20),
      ],
      { 10: [1, 1], 20: [2, 0] },
    ),
  );
}

// --- alpha: mix, alpha over, combine, and separate feeding them ---------------
check(
  "alpha",
  graph(
    [
      [1, "input/coordinates", {}],
      [2, "vector/separate", {}, 10],
      [3, "const/color", { r: 1, g: 0, b: 0, a: 0.5 }],
      [4, "const/color", { r: 0, g: 0.25, b: 1, a: 1 }],
      [5, "color/over", { fac: 1 }, 20, 30, 40],
      [6, "math/mix", { fac: 0.5 }, 21, 50, 31],
      [7, "vector/combine", { r: 0, g: 0, b: 0, a: 1 }, 60, 22, 61, null],
      out(8, 70),
    ],
    {
      10: [1, 0], 20: [2, 0], 21: [2, 1], 22: [2, 3],
      30: [3, 0], 31: [3, 0], 40: [4, 0], 50: [5, 0], 60: [6, 0], 61: [6, 0], 70: [7, 0],
    },
  ),
);

// --- images: both packed formats, both filters, both wrap modes ---------------
for (const opaque of [true, false]) {
  for (const filter of ["nearest", "linear"]) {
    for (const wrap of ["repeat", "clamp", "clip"]) {
      const images = new Map([[1, testImage(5, 3, opaque)]]);
      check(
        `image:${opaque ? "rgb565" : "rgba"}:${filter}:${wrap}`,
        graph(
          [
            [1, "texture/image", { wrap, filter }, 10],
            [2, "input/coordinates", {}],
            // Scaled UV, so sampling runs off both ends and the wrap mode matters.
            [3, "math/math", { op: "multiply", a: 0, b: 2.5 }, 20, null],
            out(4, 30),
          ],
          { 10: [3, 0], 20: [2, 0], 30: [1, 0] },
        ),
        images,
      );
    }
  }
}

// The image node's alpha output, and an Image node with nothing uploaded.
check(
  "image:alpha-out",
  graph([[1, "texture/image", { wrap: "repeat", filter: "nearest" }, null], out(2, 10)], { 10: [1, 1] }),
  new Map([[1, testImage(4, 4, false)]]),
);
check("image:missing", graph([[1, "texture/image", {}, null], out(2, 10)], { 10: [1, 0] }));

// --- sensors: every range, raw and unit, with and without a live feed ---------
for (let r = 0; r < 5; r++) {
  const range = ["0..1", "-1..1", "0..inf", "-inf..inf", "0..360"][r];
  for (const slot of [0, 1]) {
    const g = graph(
      [
        [1, "input/sensor", { range, index: slot, test: 0.375 }],
        out(2, 10),
      ],
      { 10: [1, 1] },
    );
    check(`sensor:${range}:baked`, g); // no feed at all: the baked value is used
    check(`sensor:${range}:live`, g, new Map(), 0, [12.5, -3.25]);
  }
}

// --- pixel coordinates, brightness, and a program that is one constant --------
check(
  "pixel+brightness",
  graph([[1, "input/coordinates", {}], [2, "output/led", { brightness: 0.6 }, 10]], { 10: [1, 2] }),
);
check("constant-only", graph([[1, "const/color", { r: 0.2, g: 0.9, b: 0.44, a: 1 }], out(2, 10)], { 10: [1, 0] }));

console.log(
  `crosscheck: ok - ${cases} programs, ${pixels} channels, ` +
    `${((exact / pixels) * 100).toFixed(2)}% bit-identical, worst difference ${worst}/255`,
);
