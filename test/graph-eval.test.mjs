// Self-check for the shader graph evaluator (web/graph.ts + web/nodes.ts).
//
//   node test/graph-eval.test.mjs      (or: npm test)
//
// esbuild strips the types and neither module touches the DOM at import time, so the whole
// evaluator runs in plain node - no browser, no framework, no fixtures. If the maths or the
// alpha handling breaks, this fails; test/test.cpp is the same deal for the runtime.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outfile = join(mkdtempSync(join(tmpdir(), "protoshade-")), "graph.mjs");
await esbuild.build({
  entryPoints: [join(root, "web", "graph.ts")],
  outfile,
  bundle: true,
  format: "esm",
  logLevel: "warning",
});
const { compile } = await import(pathToFileURL(outfile));

const env = (over = {}) => ({
  x: 0, y: 0, u: 0.25, v: 0.5, w: 64, h: 32, t: 2, frame: 0, images: new Map(), ...over,
});
const near = (got, want, what) => {
  assert.equal(got.length, 4, `${what}: not an RGBA quad`);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(got[i] - want[i]) < 1e-6, `${what}: ${got} != ${want}`);
  }
};

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

// --- no output node, nothing to render -------------------------------------
assert.equal(compile(graph([[1, "const/value", { value: 1 }]], {})), null);

// --- coordinates -> separate -> R -> output ---------------------------------
{
  const c = compile(
    graph(
      [
        [1, "input/coordinates", {}],
        [2, "vector/separate", {}, 10],
        [3, "output/led", { brightness: 1 }, 20],
        [9, "const/value", { value: 7 }], // dead branch: must not be evaluated
      ],
      { 10: [1, 0], 20: [2, 0] },
    ),
  );
  near(c.shade(env()), [0.25, 0.25, 0.25, 1], "u through separate");
  near(c.shade(env({ u: 0.5 })), [0.5, 0.5, 0.5, 1], "u through separate");
  assert.equal(c.size, 3, "dead branch should be skipped");
}

// --- math: the guarded ops ---------------------------------------------------
{
  const math = (props, inputs = {}) =>
    compile(
      graph(
        [
          [1, "math/math", props, inputs.a ?? null, inputs.b ?? null],
          [2, "output/led", { brightness: 1 }, 20],
        ],
        { 20: [1, 0] },
      ),
    ).shade(env());
  near(math({ op: "divide", a: 1, b: 0 }), [0, 0, 0, 1], "divide by zero is 0, not Infinity");
  near(math({ op: "modulo", a: -0.25, b: 1 }), [0.75, 0.75, 0.75, 1], "modulo is floored");
  near(math({ op: "sqrt", a: -4, b: 0 }), [0, 0, 0, 1], "sqrt of a negative is 0, not NaN");
  near(math({ op: "add", a: 0.25, b: 0.5 }), [0.75, 0.75, 0.75, 1], "add");
  near(math({ op: "smoothstep", a: 0.5, b: 0 }), [0.5, 0.5, 0.5, 1], "smoothstep(0.5)");
  near(math({ op: "clamp", a: 3, b: 0 }), [1, 1, 1, 1], "clamp");
  // An unknown op must not throw - a saved graph can name one this build dropped.
  near(math({ op: "nope", a: 0.25, b: 0.5 }), [0.75, 0.75, 0.75, 1], "unknown op falls back to add");
}

// --- alpha: scalars stay opaque, Alpha Over composites, output flattens -------
{
  // Half-transparent red over opaque blue, straight alpha in and out.
  const over = compile(
    graph(
      [
        [1, "const/color", { r: 1, g: 0, b: 0, a: 0.5 }],
        [2, "const/color", { r: 0, g: 0, b: 1, a: 1 }],
        [3, "color/over", { fac: 1 }, null, 10, 20],
        [4, "output/led", { brightness: 1 }, 30],
      ],
      { 10: [1, 0], 20: [2, 0], 30: [3, 0] },
    ),
  );
  near(over.shade(env()), [0.5, 0, 0.5, 1], "red 50% over blue");

  // Same graph, but the output takes the transparent foreground straight: an LED has
  // nothing behind it, so alpha composites against black.
  const flat = compile(
    graph(
      [
        [1, "const/color", { r: 1, g: 0, b: 0, a: 0.5 }],
        [4, "output/led", { brightness: 1 }, 30],
      ],
      { 30: [1, 0] },
    ),
  );
  near(flat.shade(env()), [0.5, 0, 0, 1], "alpha flattens against black");

  // A plain number is opaque - broadcasting 0.5 into alpha would silently halve everything.
  const scalar = compile(
    graph(
      [
        [1, "const/value", { value: 0.5 }],
        [4, "output/led", { brightness: 1 }, 30],
      ],
      { 30: [1, 0] },
    ),
  );
  near(scalar.shade(env()), [0.5, 0.5, 0.5, 1], "scalar broadcasts to alpha 1");
}

// --- image node: sampling, wrap, and the no-upload case ----------------------
{
  // 2x1: opaque green, transparent black.
  const img = { w: 2, h: 1, data: Uint8ClampedArray.from([0, 255, 0, 255, 0, 0, 0, 0]) };
  const g = graph(
    [
      [1, "texture/image", { wrap: "repeat", filter: "nearest" }, null],
      [2, "output/led", { brightness: 1 }, 30],
    ],
    { 30: [1, 0] },
  );
  const c = compile(g);
  near(c.shade(env({ u: 0.25, images: new Map([[1, img]]) })), [0, 1, 0, 1], "left texel");
  near(c.shade(env({ u: 0.75, images: new Map([[1, img]]) })), [0, 0, 0, 1], "right texel is clear");
  // Out of range u wraps back onto the left texel instead of reading out of bounds.
  near(c.shade(env({ u: -0.75, images: new Map([[1, img]]) })), [0, 1, 0, 1], "u wraps");
  near(c.shade(env()), [0, 0, 0, 1], "no upload renders as transparent, not a crash");
}

// --- sensor: declared range, test value, live feed, index --------------------
{
  const sensor = (props, slot, e = {}) => {
    const c = compile(
      graph(
        [
          [1, "input/sensor", props],
          [2, "output/led", { brightness: 1 }, 20],
        ],
        { 20: [1, slot] },
      ),
    );
    return c.shade(env(e));
  };
  // Raw output is the reading itself; Unit squashes it into 0..1 without clipping.
  near(sensor({ range: "0..inf", index: 0, test: 3 }, 0), [1, 1, 1, 1], "raw 3 clamps at the LED");
  near(sensor({ range: "0..inf", index: 0, test: 3 }, 1), [0.75, 0.75, 0.75, 1], "3 -> 0.75 unit");
  near(sensor({ range: "0..inf", index: 0, test: 300 }, 1), [300 / 301, 300 / 301, 300 / 301, 1], "300 saturates but still differs");
  near(sensor({ range: "-inf..inf", index: 0, test: -1 }, 1), [0.25, 0.25, 0.25, 1], "signed midpoint is 0.5");
  near(sensor({ range: "0..360", index: 0, test: 450 }, 1), [0.25, 0.25, 0.25, 1], "degrees wrap");
  near(sensor({ range: "-1..1", index: 0, test: -5 }, 1), [0, 0, 0, 1], "out of declared range clamps");

  // A live feed wins over the test widget; a missing index reads 0, not undefined.
  near(sensor({ range: "0..1", index: 1, test: 0.5 }, 0, { sensors: [0.1, 0.9] }), [0.9, 0.9, 0.9, 1], "live reading by index");
  near(sensor({ range: "0..1", index: 7, test: 0.5 }, 0, { sensors: [0.1] }), [0.5, 0.5, 0.5, 1], "index past the feed falls back to test");
  near(sensor({ range: "0..1", index: -2.6, test: 0.25 }, 0, { sensors: [0.8] }), [0.8, 0.8, 0.8, 1], "index is rounded and floored at 0");

  // Sweep ignores the test widget and walks the declared range instead.
  const swept = (t) => sensor({ range: "-1..1", index: 0, test: 0.123, sweep: true }, 1, { t });
  near(swept(0), [0.5, 0.5, 0.5, 1], "sweep starts mid-range");
  near(swept(Math.PI / 3), [1, 1, 1, 1], "sweep reaches the top of the range");
  // ...but a live reading still wins over the sweep.
  near(
    sensor({ range: "-1..1", index: 0, test: 0.123, sweep: true }, 1, { t: Math.PI / 3, sensors: [-1] }),
    [0, 0, 0, 1],
    "live reading beats the sweep",
  );
}

// --- a cycle must not hang or blow the stack ---------------------------------
{
  const c = compile(
    graph(
      [
        [1, "math/math", { op: "add", a: 0.25, b: 0 }, 10, null],
        [2, "output/led", { brightness: 1 }, 20],
      ],
      { 10: [1, 0], 20: [1, 0] }, // node 1's A input reads node 1
    ),
  );
  near(c.shade(env()), [0.25, 0.25, 0.25, 1], "back edge reads as unconnected");
}

console.log("graph-eval: ok");
