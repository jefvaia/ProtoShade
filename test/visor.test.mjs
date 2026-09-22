// Self-check for the visor mesh (web/visor.ts).
//
//   node test/visor.test.mjs      (or: npm test)
//
// The WebGL half needs a GPU and a canvas; the geometry does not, and the geometry is where
// the claims are - that half the canvas lands on each side, that the halves meet at the
// nose, and that the normals point away from the head rather than into it.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), "protoshade-visor-"));
const entry = join(work, "entry.ts");
writeFileSync(entry, `export { visorGeometry } from ${JSON.stringify(join(root, "web/visor.ts"))};\n`);
const bundle = join(work, "bundle.mjs");
await esbuild.build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "esm", logLevel: "warning" });
const { visorGeometry } = await import(pathToFileURL(bundle));

const segments = 8;
const g = visorGeometry(segments);
const verts = g.pos.length / 3;

assert.equal(verts, 2 * 2 * (segments + 1), "two sides, two rows each");
assert.equal(g.idx.length, 2 * segments * 6);
assert.ok(Math.max(...g.idx) < verts, "every index points at a vertex that exists");
// arc decides how tall the panel is drawn, so a texel is square only when it really is the
// length of the strip. Walk the top row of one side and measure it off the mesh itself.
let measured = 0;
for (let i = 2; i <= segments * 2; i += 2) {
  measured += Math.hypot(g.pos[i * 3] - g.pos[(i - 2) * 3], g.pos[i * 3 + 2] - g.pos[(i - 2) * 3 + 2]);
}
assert.ok(Math.abs(measured - g.arc) < 1e-5, `arc says ${g.arc}, the strip measures ${measured}`); // float32 mesh
assert.ok(g.arc > 1, `one side should be more than a unit long, got ${g.arc}`);

// Every texel of the canvas is on the head exactly once: u runs 0..0.5 on one side and
// 0.5..1 on the other, v the full height, and 0.5 - the nose - is where they touch.
const gap = Math.min(...[...Array(verts)].map((_, i) => Math.abs(g.pos[i * 3])));
assert.ok(gap > 0.02, `the panels should clear the nose, got ${gap}`);

const zs = [...Array(verts)].map((_, i) => g.pos[i * 3 + 2]);
const frontmost = Math.max(...zs);

const us = [...Array(verts)].map((_, i) => g.uv[i * 2]);
const vs = [...Array(verts)].map((_, i) => g.uv[i * 2 + 1]);
assert.equal(Math.min(...us), 0);
assert.equal(Math.max(...us), 1);
assert.equal(Math.min(...vs), 0);
assert.equal(Math.max(...vs), 1);

for (let i = 0; i < verts; i++) {
  const [x, y, z] = [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]];
  const u = g.uv[i * 2];
  // The middle of the canvas is the inner edge of each panel: at the front, and clear of the
  // centre line by the nose gap, because the two matrices do not touch on a real head.
  if (Math.abs(u - 0.5) < 1e-6) {
    assert.equal(Math.abs(x), gap);
    assert.equal(z, frontmost, "the inner edge is the frontmost point");
  }
  assert.ok(Math.abs(x) >= gap - 1e-6, "nothing crosses into the nose gap");
  // Which half of the canvas a vertex shows decides which side of the face it is on.
  if (u < 0.5) assert.ok(x <= 0);
  if (u > 0.5) assert.ok(x >= 0);
  assert.equal(Math.abs(y), 0.5, "flat panels: two rows, scaled by the texture aspect later");

  const [nx, ny, nz] = [g.nrm[i * 3], g.nrm[i * 3 + 1], g.nrm[i * 3 + 2]];
  assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-5, "normals are unit length");
  assert.equal(ny, 0);
  // Outward, not inward: from the centre of the head towards the vertex.
  assert.ok(nx * x + nz * (z + 0.5) > 0, `normal ${i} faces into the head`);
}

console.log("visor: ok");
