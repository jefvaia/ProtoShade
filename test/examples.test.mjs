// Every example in the header dropdown compiles, and fits on a head.
//
//   node test/examples.test.mjs      (or: npm test)
//
// The examples are data - nodes, widgets and wires - so the compiler can be pointed straight
// at them. That makes this the check that a renamed node type, a reordered output slot or a
// widget that lost its default turns into a failing test rather than a broken dropdown.
//
// The art is NOT drawn here: it needs a canvas. An example whose images are missing still
// compiles (a missing upload is a 1x1 transparent asset), which is exactly the path this
// exercises, so the shape of the graph is what gets checked.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), "protoshade-"));
const entry = join(work, "entry.ts");
writeFileSync(
  entry,
  `export { compile } from ${JSON.stringify(join(root, "web/graph.ts"))};\n` +
    `export { packedSize, instructionCount, PARTITION_BYTES } from ${JSON.stringify(join(root, "web/pack.ts"))};\n` +
    `export { NODES, MAX_REGISTERS } from ${JSON.stringify(join(root, "web/nodes.ts"))};\n` +
    `export { EXAMPLES } from ${JSON.stringify(join(root, "web/examples.ts"))};\n`,
);
const bundle = join(work, "bundle.mjs");
await esbuild.build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "esm", logLevel: "warning" });
const { compile, packedSize, instructionCount, PARTITION_BYTES, NODES, MAX_REGISTERS, EXAMPLES } = await import(pathToFileURL(bundle));

/** An example turned into the shape compile() reads: inputs are per-slot, links are by id. */
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
      // Widgets an example does not set keep the node's own default, exactly as a node
      // dropped from the right-click menu would.
      properties: { ...defaults(n.type), ...(n.props ?? {}) },
      inputs: (NODES[n.type].in ?? []).map((_, i) => ({ link: inputs.get(n.id)[i] ?? null })),
    })),
    links,
  };
}

const defaults = (type) =>
  Object.fromEntries(Object.entries(NODES[type].props ?? {}).map(([key, def]) => [key, def.value]));

assert.ok(EXAMPLES.length > 0, "there is at least one example");
const names = new Set();

for (const ex of EXAMPLES) {
  assert.ok(ex.name && ex.desc, "an example says what it is");
  assert.ok(!names.has(ex.name), `duplicate example name: ${ex.name}`);
  names.add(ex.name);

  // Every node type is one the compiler can emit, and every wire lands on a real socket.
  const ids = new Set();
  for (const n of ex.nodes) {
    assert.ok(NODES[n.type], `${ex.name}: unknown node type ${n.type}`);
    assert.ok(!ids.has(n.id), `${ex.name}: duplicate node id ${n.id}`);
    ids.add(n.id);
  }
  for (const [from, fromSlot, to, toSlot] of ex.links) {
    const source = ex.nodes.find((n) => n.id === from);
    const target = ex.nodes.find((n) => n.id === to);
    assert.ok(source && target, `${ex.name}: a wire names a node that is not there`);
    assert.ok(fromSlot < NODES[source.type].out.length, `${ex.name}: ${source.type} has no output ${fromSlot}`);
    assert.ok(toSlot < (NODES[target.type].in ?? []).length, `${ex.name}: ${target.type} has no input ${toSlot}`);
  }
  for (const id of Object.keys(ex.art ?? {})) {
    const node = ex.nodes.find((n) => n.id === Number(id));
    assert.ok(node && NODES[node.type].props?.file, `${ex.name}: art for a node that takes no image`);
  }

  const result = compile(toGraph(ex), new Map(), 64, 32);
  assert.ok(result.ok, `${ex.name}: ${result.ok ? "" : result.reason}`);
  const n = instructionCount(result.program);
  assert.ok(n <= MAX_REGISTERS, `${ex.name}: ${n} instructions, over the ${MAX_REGISTERS} a head has registers for`);
  // An example that does not fit on the hardware it ships with is not an example.
  assert.ok(packedSize(result.program) <= PARTITION_BYTES, `${ex.name}: too big for the partition`);
}

// --- the editor's idea of the partition is the partition -----------------------
//
// partitions.csv is the original - the firmware never hardcodes a size, it looks the
// partition up by label - and web/pack.ts carries a copy so the editor can warn you before
// you try to flash a .bin that will not fit. Two numbers, so read the real one and compare.
{
  const table = readFileSync(join(root, "partitions.csv"), "utf8");
  const row = table
    .split("\n")
    .map((line) => line.split("#")[0].split(",").map((cell) => cell.trim()))
    .find((cells) => cells[0] === "protoshade");
  assert.ok(row, "partitions.csv still has a protoshade partition");
  const [, , , offset, size] = row;
  assert.equal(
    Number(size),
    PARTITION_BYTES,
    `partitions.csv gives protoshade ${Number(size)} bytes, web/pack.ts says ${PARTITION_BYTES}`,
  );
  // Nothing may start inside it either, or the .bin and something else share flash.
  for (const cells of table.split("\n").map((l) => l.split("#")[0].split(",").map((c) => c.trim()))) {
    if (cells.length < 5 || !cells[3] || cells[0] === "protoshade" || cells[0] === "name") continue;
    const at = Number(cells[3]);
    assert.ok(
      at + Number(cells[4]) <= Number(offset) || at >= Number(offset) + PARTITION_BYTES,
      `partition ${cells[0]} overlaps protoshade`,
    );
  }
}

// The baked example has to actually bake: its plasma branch is gone from the program, and
// what is left is the four-instruction lookup.
{
  const baked = EXAMPLES.find((ex) => ex.nodes.some((n) => n.type === "bake/bake"));
  assert.ok(baked, "one example shows what Bake does");
  const result = compile(toGraph(baked), new Map(), 64, 32);
  assert.ok(result.ok);
  assert.equal(instructionCount(result.program), 4, "baked down to UV, phase, lookup, output");
  assert.equal(result.program.assets.length, 1, "and one strip to look into");
}

console.log(`examples: ok - ${EXAMPLES.length} compile`);
