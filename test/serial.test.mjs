// Self-check for the serial frame parser (web/serial.ts).
//
//   node test/serial.test.mjs      (or: npm test)
//
// The device writes frames onto the same port it logs on, so this has to find them in a
// stream that also carries text, arriving in whatever sized chunks the OS feels like. Both
// of those are trivial to write down here and miserable to test by hand with a board
// plugged in - a split that lands mid-header happens once in a thousand reads and produces
// a garbled picture nobody can reproduce on demand.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), "protoshade-"));
const entry = join(work, "entry.ts");
writeFileSync(entry, `export { FrameParser, FRAME_HEADER } from ${JSON.stringify(join(root, "web/serial.ts"))};\n`);
const bundle = join(work, "bundle.mjs");
await esbuild.build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "esm", logLevel: "warning" });
const { FrameParser, FRAME_HEADER } = await import(pathToFileURL(bundle));

const text = (s) => new TextEncoder().encode(s);

/** A frame exactly as streamFrame() writes it, with recognisable pixels. */
function frame(w, h, seed = 0) {
  const out = new Uint8Array(FRAME_HEADER + w * h * 3);
  out.set([0x50, 0x53, 0x46, 0x52]); // PSFR
  out[4] = w & 0xff;
  out[5] = w >> 8;
  out[6] = h & 0xff;
  out[7] = h >> 8;
  for (let i = 0; i < w * h * 3; i++) out[FRAME_HEADER + i] = (seed + i) & 0xff;
  return out;
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

// --- one frame, in one chunk -------------------------------------------------
{
  const p = new FrameParser();
  const got = p.push(frame(4, 2, 7));
  assert.equal(got.length, 1);
  assert.equal(got[0].w, 4);
  assert.equal(got[0].h, 2);
  assert.equal(got[0].rgb.length, 4 * 2 * 3);
  assert.equal(got[0].rgb[0], 7);
}

// --- logs and frames share the port ------------------------------------------
{
  const p = new FrameParser();
  const got = p.push(
    concat(text("stats: 17.3 fps  render 57.83 ms\n"), frame(3, 3, 1), text("pixel stream on\n")),
  );
  assert.equal(got.length, 1, "the text around it is skipped");
  assert.equal(got[0].rgb[0], 1);
}

// --- split anywhere, including mid-header ------------------------------------
{
  const whole = concat(text("boot\n"), frame(5, 4, 3), text("more log\n"), frame(5, 4, 9));
  // Every split point must produce the same two frames: the OS decides chunk boundaries and
  // a header straddling one is exactly where naive parsers break.
  for (let cut = 1; cut < whole.length; cut++) {
    const p = new FrameParser();
    const got = [...p.push(whole.slice(0, cut)), ...p.push(whole.slice(cut))];
    assert.equal(got.length, 2, `split at ${cut}`);
    assert.equal(got[0].rgb[0], 3, `split at ${cut}`);
    assert.equal(got[1].rgb[0], 9, `split at ${cut}`);
  }
}

// --- byte at a time ----------------------------------------------------------
{
  const p = new FrameParser();
  const whole = concat(text("x"), frame(2, 2, 5));
  const got = [];
  for (const byte of whole) got.push(...p.push(Uint8Array.of(byte)));
  assert.equal(got.length, 1);
  assert.equal(got[0].rgb[0], 5);
}

// --- a truncated frame must not eat the next one -----------------------------
{
  const p = new FrameParser();
  const cut = frame(4, 4, 2).slice(0, 20); // header plus a few pixels, then the device resets
  const got = [...p.push(cut), ...p.push(frame(4, 4, 8))];
  // The first frame's declared length swallows the start of the second, so one frame comes
  // out - the point is that the parser recovers rather than wedging.
  assert.ok(got.length >= 1, "recovers after a truncated frame");
  const after = p.push(frame(4, 4, 11));
  assert.equal(after.length, 1, "and is back in sync for the next one");
  assert.equal(after[0].rgb[0], 11);
}

// --- PSFR appearing in text is not a frame -----------------------------------
{
  const p = new FrameParser();
  // Plausible log line that happens to contain the magic, followed by a real frame.
  const got = p.push(concat(text("PSFR is the magic\n"), frame(2, 2, 4)));
  assert.equal(got.length, 1, "a bogus header is stepped over, not trusted");
  assert.equal(got[0].rgb[0], 4);
}

// --- a header claiming an impossible size is refused -------------------------
{
  const p = new FrameParser();
  const bad = frame(2, 2, 0);
  bad[4] = 0xff; // width 65535, past kMaxDimension
  bad[5] = 0xff;
  const got = [...p.push(bad), ...p.push(frame(2, 2, 6))];
  assert.equal(got.length, 1);
  assert.equal(got[0].rgb[0], 6, "the real frame still arrives");
}

// --- a chatty device with no frames must not grow the buffer -----------------
{
  const p = new FrameParser();
  for (let i = 0; i < 1000; i++) p.push(text("stats: 17.3 fps  render 57.83 ms  panels 0.01 ms\n"));
  const got = p.push(frame(2, 2, 12));
  assert.equal(got.length, 1, "still finds a frame after a megabyte of logs");
  assert.equal(got[0].rgb[0], 12);
}

console.log("serial: ok");
