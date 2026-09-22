// Importing a .bin gives back a graph that compiles to the same picture.
//
//   node test/unpack.test.mjs      (or: npm test)
//
// For every example: compile it, pack it, read the .bin back as a graph, compile THAT, and
// render both programs pixel by pixel. What is checked is the round trip of the program -
// the same thing the head renders - not the bytes, because the importer is allowed to be
// tidier than the graph it reads: two nodes that both asked for the pixel's UV come back as
// one Coordinates node feeding two wires, which is one instruction fewer and the same face.
//
// The art is drawn here rather than mocked: assets go into the .bin as packed pixels, and
// the importer has to hand them back as the exact same pixels or a sprite lands elsewhere.

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
  `export { compile, Runner } from ${JSON.stringify(join(root, "web/graph.ts"))};\n` +
    `export { pack } from ${JSON.stringify(join(root, "web/pack.ts"))};\n` +
    `export { unpack } from ${JSON.stringify(join(root, "web/unpack.ts"))};\n` +
    `export { NODES } from ${JSON.stringify(join(root, "web/nodes.ts"))};\n` +
    `export { EXAMPLES } from ${JSON.stringify(join(root, "web/examples.ts"))};\n`,
);
const bundle = join(work, "bundle.mjs");
await esbuild.build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "esm", logLevel: "warning" });
const { compile, Runner, pack, unpack, NODES, EXAMPLES } = await import(pathToFileURL(bundle));

const W = 64;
const H = 32;

const defaults = (type) =>
  Object.fromEntries(Object.entries(NODES[type].props ?? {}).map(([key, def]) => [key, def.value]));

/** An example (or an import) in the shape compile() reads. Same helper examples.test.mjs uses. */
function toGraph(ex) {
  const links = {};
  const inputs = new Map(ex.nodes.map((n) => [n.id, []]));
  ex.links.forEach(([from, fromSlot, to, toSlot], i) => {
    const id = i + 1;
    links[id] = { origin_id: from, origin_slot: fromSlot };
    inputs.get(to)[toSlot] = id;
  });
  return {
    _nodes: ex.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      properties: { ...defaults(n.type), ...(n.props ?? {}) },
      inputs: (NODES[n.type].in ?? []).map((_, i) => ({ link: inputs.get(n.id)[i] ?? null })),
    })),
    links,
  };
}

/** The art an example declares, drawn into the buffers `images` holds - no canvas needed:
    every example's art is a shape, and what this test needs is that the SAME bytes survive
    the round trip, not that they look like anything. */
function artImages(ex) {
  const images = new Map();
  for (const [id, art] of Object.entries(ex.art ?? {})) {
    const w = art.w;
    const h = art.h * art.frames;
    const data = new Uint8ClampedArray(w * h * 4);
    // A gradient with alpha in it, so the packer picks RGBA8888 for some assets and RGB565
    // for others and both paths through the importer get exercised.
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = (i * 7) & 255;
      data[i * 4 + 1] = (i * 13) & 255;
      data[i * 4 + 2] = (i * 29) & 255;
      data[i * 4 + 3] = Number(id) % 2 === 0 ? 255 : (i * 3) & 255;
    }
    images.set(Number(id), { w, h, frames: art.frames, data });
  }
  return images;
}

/** Every pixel, the same loop main.ts previews with. */
function render(program) {
  const runner = new Runner(program);
  const env = { x: 0, y: 0, u: 0, v: 0, w: W, h: H, t: 1.234, frame: 0, sensors: [0.3, 0.6] };
  const colour = [0, 0, 0, 1];
  const buf = Buffer.alloc(W * H * 4);
  for (let y = 0, p = 0; y < H; y++) {
    for (let x = 0; x < W; x++, p += 4) {
      env.x = x;
      env.y = y;
      env.u = (x + 0.5) / W;
      env.v = (y + 0.5) / H;
      runner.run(env, colour);
      for (let c = 0; c < 4; c++) buf[p + c] = Math.round(colour[c] * 255);
    }
  }
  return buf;
}

let checked = 0;
for (const ex of EXAMPLES) {
  const before = compile(toGraph(ex), artImages(ex), W, H);
  assert.ok(before.ok, `${ex.name}: ${before.reason ?? ""}`);

  const imported = unpack(pack(before.program));
  assert.equal(imported.width, W, `${ex.name}: the authored width survives`);
  assert.equal(imported.height, H, `${ex.name}: the authored height survives`);

  const after = compile(toGraph(imported.example), imported.images, W, H);
  assert.ok(after.ok, `${ex.name}: the imported graph compiles - ${after.reason ?? ""}`);

  // The assets must come back byte for byte: a packed 565 expanded the wrong way repacks to
  // a different colour, and a sprite sheet whose frame count was lost samples the wrong row.
  assert.deepEqual(
    after.program.assets.map((a) => [a.w, a.h, a.frames, a.format, [...a.data]]),
    before.program.assets.map((a) => [a.w, a.h, a.frames, a.format, [...a.data]]),
    `${ex.name}: the art survives the round trip`,
  );
  assert.equal(after.program.sensorCount, before.program.sensorCount, `${ex.name}: sensor slots survive`);

  const a = render(before.program);
  const b = render(after.program);
  const at = a.findIndex((v, i) => v !== b[i]);
  assert.equal(at, -1, `${ex.name}: pixel ${(at >> 2) % W},${Math.floor(at / 4 / W)} differs after a round trip`);

  // Tidier or the same, never more work for the head.
  assert.ok(
    after.program.code.length <= before.program.code.length,
    `${ex.name}: the import is ${after.program.code.length / 8} instructions, was ${before.program.code.length / 8}`,
  );
  checked++;
}

// A file that is not one of ours has to say so rather than produce a broken graph.
for (const [why, bytes] of [
  ["too short", new Uint8Array(8)],
  ["wrong magic", new Uint8Array(64)],
  ["truncated", pack(compile(toGraph(EXAMPLES[0]), artImages(EXAMPLES[0]), W, H).program).slice(0, 60)],
]) {
  assert.throws(() => unpack(bytes), `a .bin that is ${why} is refused`);
}

console.log(`unpack: ${checked} examples round-tripped through a .bin`);
