// Self-check for the compiler and the TypeScript interpreter (web/graph.ts, web/pack.ts).
//
//   node test/graph.test.mjs      (or: npm test)
//
// esbuild strips the types and nothing here touches the DOM at import time, so it all runs
// in plain node - no browser, no framework, no fixtures. This file is about the compiler:
// what the graph turns into, and what the maths does. Whether the C++ VM agrees is
// test/crosscheck.mjs, and whether the container bytes are right is test/test.cpp.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), "protoshade-"));
const entry = join(work, "entry.ts");
writeFileSync(
  entry,
  `export { compile, Runner, packImage } from ${JSON.stringify(join(root, "web/graph.ts"))};\n` +
    `export { pack, packedSize, instructionCount, HEADER_SIZE, FORMAT_VERSION } from ${JSON.stringify(join(root, "web/pack.ts"))};\n` +
    `export { OP, INSTR_SIZE, MAX_REGISTERS } from ${JSON.stringify(join(root, "web/nodes.ts"))};\n`,
);
const bundle = join(work, "bundle.mjs");
await esbuild.build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "esm", logLevel: "warning" });
const { compile, Runner, packImage, pack, packedSize, instructionCount, HEADER_SIZE, FORMAT_VERSION, OP, INSTR_SIZE, MAX_REGISTERS } =
  await import(pathToFileURL(bundle));

const env = (over = {}) => ({ x: 0, y: 0, u: 0.25, v: 0.5, w: 64, h: 32, t: 2, frame: 0, ...over });

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

/** Compiles and runs one pixel. */
function shade(g, images = new Map(), e = {}) {
  const r = compile(g, images, 64, 32);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  const colour = [0, 0, 0, 1];
  new Runner(r.program).run(env(e), colour);
  return { colour, program: r.program };
}

const near = (got, want, what) => {
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(got[i] - want[i]) < 1e-6, `${what}: ${got} != ${want}`);
  }
};

// --- a graph with no output node compiles to nothing -------------------------
{
  const r = compile(graph([[1, "const/value", { value: 1 }]], {}), new Map());
  assert.equal(r.ok, false);
  assert.match(r.reason, /LED Output/);
}

// --- what the compiler emits -------------------------------------------------
{
  const { program } = shade(
    graph(
      [
        [1, "input/coordinates", {}],
        [2, "vector/separate", {}, 10],
        out(3, 20),
        [9, "const/value", { value: 7 }], // dead branch: never reached from the output
      ],
      { 10: [1, 0], 20: [2, 0] },
    ),
  );
  // UV, Swizzle, Output - the dead constant node is not in the program at all.
  assert.equal(instructionCount(program), 3);
  assert.deepEqual([...program.code.filter((_, i) => i % INSTR_SIZE === 0)], [OP.UV, OP.SWIZZLE, OP.OUTPUT]);
  assert.equal(program.code[program.code.length - INSTR_SIZE], OP.OUTPUT, "output is last");

  // A node feeding two inputs is emitted once, not twice.
  const twice = shade(
    graph(
      [
        [1, "input/coordinates", {}],
        [2, "math/math", { op: "add", a: 0, b: 0 }, 10, 11],
        out(3, 20),
      ],
      { 10: [1, 0], 11: [1, 0], 20: [2, 0] },
    ),
  );
  assert.equal(instructionCount(twice.program), 3, "shared node compiled once");
}

// --- constants are pooled, and a pure-constant node is not an instruction -----
{
  const { program } = shade(
    graph(
      [
        [1, "const/color", { r: 0.25, g: 0.5, b: 1, a: 1 }],
        out(2, 10),
      ],
      { 10: [1, 0] },
    ),
  );
  assert.equal(instructionCount(program), 1, "only the output instruction");
  // The colour and the brightness, and nothing repeated.
  assert.equal(program.consts.length / 4, 2);
  near([...program.consts.slice(0, 4)], [0.25, 0.5, 1, 1], "colour constant");
}

// --- the maths, through the interpreter --------------------------------------
{
  const math = (props) =>
    shade(graph([[1, "math/math", props], out(2, 10)], { 10: [1, 0] })).colour;
  near(math({ op: "divide", a: 1, b: 0 }), [0, 0, 0, 1], "divide by zero is 0, not Infinity");
  near(math({ op: "modulo", a: -0.25, b: 1 }), [0.75, 0.75, 0.75, 1], "modulo is floored");
  near(math({ op: "sqrt", a: -4, b: 0 }), [0, 0, 0, 1], "sqrt of a negative is 0, not NaN");
  near(math({ op: "add", a: 0.25, b: 0.5 }), [0.75, 0.75, 0.75, 1], "add");
  near(math({ op: "smoothstep", a: 0.5, b: 0 }), [0.5, 0.5, 0.5, 1], "smoothstep(0.5)");
  near(math({ op: "clamp", a: 3, b: 0 }), [1, 1, 1, 1], "clamp");
  // An op name this build does not know falls back to index 0 rather than failing.
  near(math({ op: "nope", a: 0.25, b: 0.5 }), [0.75, 0.75, 0.75, 1], "unknown op falls back to add");
}

// --- alpha: scalars stay opaque, Alpha Over composites, output flattens -------
{
  const over = shade(
    graph(
      [
        [1, "const/color", { r: 1, g: 0, b: 0, a: 0.5 }],
        [2, "const/color", { r: 0, g: 0, b: 1, a: 1 }],
        [3, "color/over", { fac: 1 }, null, 10, 20],
        out(4, 30),
      ],
      { 10: [1, 0], 20: [2, 0], 30: [3, 0] },
    ),
  ).colour;
  near(over, [0.5, 0, 0.5, 1], "red 50% over blue");

  const flat = shade(
    graph([[1, "const/color", { r: 1, g: 0, b: 0, a: 0.5 }], out(2, 10)], { 10: [1, 0] }),
  ).colour;
  near(flat, [0.5, 0, 0, 1], "alpha flattens against black");

  // A plain number is opaque - broadcasting 0.5 into alpha would silently halve everything.
  const scalar = shade(graph([[1, "const/value", { value: 0.5 }], out(2, 10)], { 10: [1, 0] })).colour;
  near(scalar, [0.5, 0.5, 0.5, 1], "scalar broadcasts to alpha 1");
}

// --- images: packing choice, sampling, wrap, and the no-upload case -----------
{
  // 2x1: opaque green, transparent black -> must pack as RGBA, alpha is real.
  const clear = { w: 2, h: 1, data: Uint8ClampedArray.from([0, 255, 0, 255, 0, 0, 0, 0]) };
  assert.equal(packImage(clear).format, 1, "an image with alpha packs as RGBA8888");
  assert.equal(packImage({ w: 1, h: 1, data: Uint8ClampedArray.from([255, 0, 0, 255]) }).format, 0, "opaque packs as RGB565");
  assert.equal(packImage({ w: 2, h: 1, data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 0, 255, 255]) }).data.length, 4, "RGB565 is 2 bytes a pixel");

  const g = graph([[1, "texture/image", { wrap: "repeat", filter: "nearest" }, null], out(2, 10)], { 10: [1, 0] });
  const images = new Map([[1, clear]]);
  near(shade(g, images, { u: 0.25 }).colour, [0, 1, 0, 1], "left texel");
  near(shade(g, images, { u: 0.75 }).colour, [0, 0, 0, 1], "right texel is clear, flattened to black");
  // Out of range u wraps back onto the left texel instead of reading out of bounds.
  near(shade(g, images, { u: -0.75 }).colour, [0, 1, 0, 1], "u wraps");
  near(shade(g, new Map(), { u: 0.25 }).colour, [0, 0, 0, 1], "no upload renders transparent, not a crash");

  // wrap modes, sampled past the right edge of the image.
  const wrapped = (wrap, u) =>
    shade(graph([[1, "texture/image", { wrap, filter: "nearest" }, null], out(2, 10)], { 10: [1, 0] }), images, { u })
      .colour;
  near(wrapped("repeat", 1.25), [0, 1, 0, 1], "repeat tiles back to the left texel");
  near(wrapped("clamp", 1.25), [0, 0, 0, 1], "clamp stretches the edge texel - here a clear one");
  near(wrapped("clip", 1.25), [0, 0, 0, 1], "clip is transparent outside the image");
  // The difference between clamp and clip shows up on an opaque edge: clamp keeps painting
  // it, clip stops. This is the smearing you see placing a sprite with scaled UV.
  const opaque = new Map([[1, { w: 2, h: 1, data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 0, 255, 255]) }]]);
  const edge = (wrap, u) =>
    shade(graph([[1, "texture/image", { wrap, filter: "nearest" }, null], out(2, 10)], { 10: [1, 0] }), opaque, { u })
      .colour;
  near(edge("clamp", 1.6), [0, 0, 1, 1], "clamp smears the last texel outwards");
  near(edge("clip", 1.6), [0, 0, 0, 1], "clip shows nothing out there");
  near(edge("clip", 0.75), [0, 0, 1, 1], "and still draws the image itself");
}

// --- sensors -----------------------------------------------------------------
{
  const sensor = (props, slot, e = {}) =>
    shade(graph([[1, "input/sensor", props], out(2, 20)], { 20: [1, slot] }), new Map(), e).colour;

  near(sensor({ range: "0..inf", index: 0, test: 3 }, 0), [1, 1, 1, 1], "raw 3 clamps at the LED");
  near(sensor({ range: "0..inf", index: 0, test: 3 }, 1), [0.75, 0.75, 0.75, 1], "3 -> 0.75 unit");
  near(sensor({ range: "0..inf", index: 0, test: 300 }, 1), [300 / 301, 300 / 301, 300 / 301, 1], "300 saturates but still differs");
  near(sensor({ range: "-inf..inf", index: 0, test: -1 }, 1), [0.25, 0.25, 0.25, 1], "signed midpoint is 0.5");
  near(sensor({ range: "0..360", index: 0, test: 450 }, 1), [0.25, 0.25, 0.25, 1], "degrees wrap");
  near(sensor({ range: "-1..1", index: 0, test: -5 }, 1), [0, 0, 0, 1], "out of declared range clamps");

  // A live reading wins over the value baked into the program; a slot the head does not
  // have falls back to it.
  near(sensor({ range: "0..1", index: 1, test: 0.5 }, 0, { sensors: [0.1, 0.9] }), [0.9, 0.9, 0.9, 1], "live reading by slot");
  near(sensor({ range: "0..1", index: 7, test: 0.5 }, 0, { sensors: [0.1] }), [0.5, 0.5, 0.5, 1], "missing slot falls back");
  near(sensor({ range: "0..1", index: -2.6, test: 0.25 }, 0, { sensors: [0.8] }), [0.8, 0.8, 0.8, 1], "slot is rounded and floored at 0");

  const { program } = shade(graph([[1, "input/sensor", { range: "0..1", index: 3, test: 0 }], out(2, 20)], { 20: [1, 0] }));
  assert.equal(program.sensorCount, 4, "sensorCount is the highest slot plus one");
}

// --- a cycle must not hang or blow the stack ---------------------------------
{
  const c = shade(
    graph(
      [
        [1, "math/math", { op: "add", a: 0.25, b: 0 }, 10, null],
        out(2, 20),
      ],
      { 10: [1, 0], 20: [1, 0] }, // node 1's A input reads node 1
    ),
  ).colour;
  near(c, [0.25, 0.25, 0.25, 1], "back edge reads as unconnected");
}

// --- a graph too big for the device is refused, not truncated ----------------
{
  const nodes = [[1, "input/coordinates", {}]];
  const links = {};
  let prev = 1;
  for (let i = 0; i < MAX_REGISTERS + 4; i++) {
    const id = 100 + i;
    nodes.push([id, "math/math", { op: "add", a: 0, b: 0.01 }, 1000 + i, null]);
    links[1000 + i] = [prev, 0];
    prev = id;
  }
  nodes.push(out(9999, 5000));
  links[5000] = [prev, 0];
  const r = compile(graph(nodes, links), new Map());
  assert.equal(r.ok, false);
  assert.match(r.reason, /too many/);
}

// --- the container header ----------------------------------------------------
{
  const { program } = shade(
    graph([[1, "texture/image", { wrap: "repeat", filter: "nearest" }, null], out(2, 10)], { 10: [1, 0] }),
    new Map([[1, { w: 2, h: 2, data: new Uint8ClampedArray(16) }]]),
  );
  const bin = pack(program);
  const view = new DataView(bin.buffer);
  assert.equal(String.fromCharCode(...bin.slice(0, 4)), "PSHD");
  assert.equal(view.getUint16(4, true), FORMAT_VERSION);
  assert.equal(view.getUint16(8, true), 64, "width hint");
  assert.equal(view.getUint16(10, true), 32, "height hint");
  assert.equal(view.getUint32(16, true), program.code.length, "code length in bytes");
  assert.equal(view.getUint32(16, true) % INSTR_SIZE, 0, "whole instructions");
  assert.equal(bin[26], program.regCount);
  assert.equal(view.getUint16(28, true), 1, "one asset");
  assert.equal(view.getUint32(36, true), bin.length, "total_length is the file length");
  assert.equal(bin.length, packedSize(program), "packedSize agrees with pack");
  assert.ok(bin.length > HEADER_SIZE);

  // The asset table entry points at bytes inside the file.
  const table = view.getUint32(32, true);
  const dataAt = view.getUint32(table, true);
  const dataLen = view.getUint32(table + 4, true);
  assert.ok(dataAt + dataLen <= bin.length, "asset data is inside the file");
  assert.equal(view.getUint16(table + 8, true), 2, "asset width");
}

console.log("graph: ok");
