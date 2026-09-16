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
    `export { OP, INSTR_SIZE, MAX_REGISTERS, MAX_PARTICLES, PARTICLE_QUADS } from ${JSON.stringify(join(root, "web/nodes.ts"))};\n`,
);
const bundle = join(work, "bundle.mjs");
await esbuild.build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "esm", logLevel: "warning" });
const { compile, Runner, packImage, pack, packedSize, instructionCount, HEADER_SIZE, FORMAT_VERSION, OP, INSTR_SIZE, MAX_REGISTERS, MAX_PARTICLES, PARTICLE_QUADS } =
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

// --- blending two things that overlap ----------------------------------------
{
  const blend = (mode, fg, bg) =>
    shade(
      graph(
        [
          [1, "const/color", fg],
          [2, "const/color", bg],
          [3, "color/over", { mode, fac: 1 }, null, 10, 20],
          out(4, 30),
        ],
        { 10: [1, 0], 20: [2, 0], 30: [3, 0] },
      ),
    ).colour;

  const red = { r: 1, g: 0, b: 0, a: 1 };
  const blue = { r: 0, g: 0, b: 1, a: 1 };
  near(blend("normal", red, blue), [1, 0, 0, 1], "normal: the foreground wins");
  near(blend("add", red, blue), [1, 0, 1, 1], "add: magenta where two opaque sprites overlap");
  near(blend("multiply", { r: 1, g: 1, b: 1, a: 1 }, { r: 0.5, g: 0.5, b: 0.5, a: 1 }), [0.5, 0.5, 0.5, 1], "multiply");
  near(blend("difference", red, red), [0, 0, 0, 1], "difference of a colour with itself is black");

  // The part of the foreground hanging off the background keeps its own colour: with no
  // background under it there is no second colour to add to. Adding over nothing must not
  // darken or brighten it.
  near(blend("add", red, { r: 0, g: 0, b: 1, a: 0 }), [1, 0, 0, 1], "add over nothing is the foreground");
  near(blend("multiply", red, { r: 0, g: 1, b: 0, a: 0 }), [1, 0, 0, 1], "multiply over nothing is not black");

  // Half-covered background: half the foreground blends, half does not.
  near(blend("add", red, { r: 0, g: 0, b: 1, a: 0.5 }), [1, 0, 0.5, 1], "add over half coverage");
}

// --- a strip, and the two ways to read its phase -----------------------------
//
// Four frames, one solid grey each: 0, 0.25, 0.5, 0.75. Whatever comes out has to be one of
// those four numbers - anything in between would be a frame nobody drew.
{
  const levels = [0, 64, 128, 191];
  // Four rows of four pixels: one row is one frame.
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let f = 0; f < 4; f++) {
    for (let i = 0; i < 4; i++) {
      const p = (f * 4 + i) * 4;
      data[p] = data[p + 1] = data[p + 2] = levels[f];
      data[p + 3] = 255;
    }
  }
  const strip = new Map([[1, { w: 4, h: 4, frames: 4, data }]]);
  const anim = (props, t) =>
    shade(
      graph([[1, "texture/animation", { wrap: "clamp", filter: "nearest", ...props }, null, null], out(2, 10)], {
        10: [1, 0],
      }),
      strip,
      { t },
    ).colour[0];

  // hold: the phase is 0..1 across the strip. Frame 1 at 0.4, frame 3 at 1 and beyond.
  const hold = { frames: 4, loop: false, crossfade: false, speed: 1 };
  assert.ok(Math.abs(anim(hold, 0) - 0) < 0.02, "hold at 0 is the first frame");
  assert.ok(Math.abs(anim(hold, 0.4) - 0.25) < 0.02, "0.4 snaps to frame 1, it does not blend");
  assert.ok(Math.abs(anim(hold, 1) - 0.75) < 0.02, "hold at 1 is the last frame");
  assert.ok(Math.abs(anim(hold, 5) - 0.75) < 0.02, "and it holds there");

  // loop: the phase counts whole cycles.
  const loop = { frames: 4, loop: true, crossfade: false, speed: 1 };
  assert.ok(Math.abs(anim(loop, 0.3) - 0.25) < 0.02, "0.3 of a cycle is frame 1");
  assert.ok(Math.abs(anim(loop, 1.3) - 0.25) < 0.02, "a cycle later, the same frame");

  // Every phase lands on a frame that exists - that is the whole contract.
  for (let i = 0; i <= 40; i++) {
    const v = anim(hold, i / 40);
    assert.ok(levels.some((l) => Math.abs(v * 255 - l) < 5), `phase ${i / 40} gave ${v}, which is not one of the four frames`);
  }
  // Unless crossfade is asked for, which is how you get an in-between image on purpose.
  const mid = anim({ frames: 4, loop: false, crossfade: true, speed: 1 }, 0.5);
  assert.ok(Math.abs(mid - 0.375) < 0.02, "crossfade halfway is halfway between two frames");
}

// --- particles: bounded, and parameters the device can find ------------------
{
  const dot = new Map([[1, { w: 1, h: 1, frames: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) }]]);
  const emitter = (over) => ({ count: 8, life: 1, size: 1, seed: 3, speed: 0.5, spread: 90, ...over });
  const { program } = shade(
    graph([[1, "texture/particles", emitter({ count: 1e6 }), null, null], out(2, 10)], { 10: [1, 0] }),
    dot,
  );
  const instr = [...program.code.filter((_, i) => i % INSTR_SIZE === 0)];
  assert.ok(instr.includes(OP.PARTICLES), "a Particles instruction is emitted");
  const at = instr.indexOf(OP.PARTICLES) * INSTR_SIZE;
  const params = program.code[at + 4];
  assert.ok(params & 0x80, "the parameters are constants, so the cost is known at load");
  const block = (params & 0x7f) * 4;
  assert.equal(program.consts[block], MAX_PARTICLES, "a silly count is clamped to the budget");
  // Five quads, in the order prepareParticles() walks them. If the block were pooled like an
  // ordinary constant, an equal quad elsewhere would break exactly this.
  assert.equal(program.consts.length - block, PARTICLE_QUADS * 4, "the block is five quads, and last");
  assert.equal(program.consts[block + 1], emitter({}).life, "quad 0 is count, life, fade, seed");
  assert.equal(program.consts[block + 5], 90, "quad 1 is direction, spread, speed, speed spread");

  // The particle table belongs to the program, so two emitters share it rather than each
  // getting 64. Clamped here, because a .bin the head would refuse is not a preview.
  const two = compile(
    graph(
      [
        [1, "texture/particles", emitter({ count: 50, seed: 1 }), null, null],
        [2, "texture/particles", emitter({ count: 50, seed: 2 }), null, null],
        [3, "color/over", { mode: "add", fac: 1 }, null, 10, 20],
        out(4, 30),
      ],
      { 10: [1, 0], 20: [2, 0], 30: [3, 0] },
    ),
    dot,
    64,
    32,
  );
  assert.ok(two.ok, two.ok ? "" : two.reason);
  const counts = [];
  for (let i = 0; i < two.program.code.length; i += INSTR_SIZE) {
    if (two.program.code[i] === OP.PARTICLES) counts.push(two.program.consts[(two.program.code[i + 4] & 0x7f) * 4]);
  }
  assert.deepEqual(counts, [50, 14], "the second emitter gets what is left of the 64");

  // The clock is read once per frame on the device, so a per-pixel one cannot be honoured.
  // Better a clear refusal here than a preview that works and a .bin the head rejects.
  const perPixel = compile(
    graph(
      [
        [1, "input/coordinates", {}],
        [2, "texture/particles", emitter({}), null, 10],
        out(3, 20),
      ],
      { 10: [1, 0], 20: [2, 0] },
    ),
    dot,
    64,
    32,
  );
  assert.equal(perPixel.ok, false);
  assert.match(perPixel.reason, /Time/);
}

// --- bake: the branch is rendered here, and what ships must still be it -------
//
// The branch is Time * 0.5, so its value at t seconds is t/2. Baked over 2 seconds into 4
// frames, then read back through the strip: what the head shows at t has to be what the
// branch showed at t, to within what RGB565 can hold.
{
  const branch = (extra, links) =>
    graph(
      [
        [1, "input/time", { speed: 0.5 }],
        [2, "bake/bake", { driver: "time", frames: 4, seconds: 2, crossfade: false }, 10],
        ...extra,
      ],
      { 10: [1, 0], ...links },
    );

  const g = branch([out(3, 20)], { 20: [2, 0] });
  const { program } = shade(g, new Map());
  assert.equal(program.assets.length, 1, "the branch became one asset");
  assert.equal(program.assets[0].frames, 4);
  assert.equal(program.assets[0].h, 32 * 4, "one frame per panel-height slice");
  const ops = [...program.code.filter((_, i) => i % INSTR_SIZE === 0)];
  assert.deepEqual(ops, [OP.UV, OP.TIME, OP.ANIM, OP.OUTPUT], "and the branch itself is gone");

  const runner = new Runner(program);
  const colour = [0, 0, 0, 1];
  for (const [t, want] of [[0, 0], [0.5, 0.25], [1, 0.5], [1.5, 0.75], [2.5, 0.25]]) {
    runner.run(env({ t }), colour);
    assert.ok(Math.abs(colour[0] - want) < 0.02, `baked t=${t} gave ${colour[0]}, wanted ${want}`);
  }

  // Baking one branch does not freeze the graph. A live sensor multiplying the baked strip
  // still moves, because only what was wired INTO the Bake node was rendered away.
  const live = branch(
    [
      [4, "input/sensor", { range: "0..1", index: 0, test: 1 }],
      [5, "math/math", { op: "multiply", a: 0, b: 1 }, 20, 30],
      out(6, 40),
    ],
    { 20: [2, 0], 30: [4, 0], 40: [5, 0] },
  );
  const lit = compile(live, new Map(), 64, 32);
  assert.ok(lit.ok, lit.ok ? "" : lit.reason);
  const r2 = new Runner(lit.program);
  r2.run(env({ t: 1, sensors: [1] }), colour);
  const full = colour[0];
  r2.run(env({ t: 1, sensors: [0.5] }), colour);
  assert.ok(Math.abs(colour[0] - full / 2) < 0.02, "the unbaked half of the graph is still live");
}

console.log("graph: ok");
