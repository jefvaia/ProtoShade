// Program -> .bin, the container the ESP32 maps out of flash and runs.
//
// The layout lives in one place, the comment at the top of src/ProtoShadeRuntime.h, and is
// read back byte-wise on the device so a big-endian port could never silently misparse it.
// test/test.cpp builds a container by hand and is the arbiter if this file and the runtime
// ever disagree; test/crosscheck.mjs packs a real graph and renders it through both.

import { INSTR_SIZE } from "./nodes.js";
import type { Program } from "./graph.js";

export const HEADER_SIZE = 48;
export const ASSET_ENTRY_SIZE = 16;
export const FORMAT_VERSION = 2;

export function pack(p: Program): Uint8Array {
  const constBytes = p.consts.length * 4;
  const constOffset = HEADER_SIZE;
  const codeOffset = constOffset + constBytes;
  const tableOffset = codeOffset + p.code.length;
  const dataOffset = tableOffset + p.assets.length * ASSET_ENTRY_SIZE;
  const total = dataOffset + p.assets.reduce((n, a) => n + a.data.length, 0);

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set([0x50, 0x53, 0x48, 0x44]); // "PSHD"
  view.setUint16(4, FORMAT_VERSION, true);
  view.setUint16(6, 0, true); // flags
  view.setUint16(8, p.width, true);
  view.setUint16(10, p.height, true);
  view.setUint32(12, codeOffset, true);
  view.setUint32(16, p.code.length, true);
  view.setUint32(20, constOffset, true);
  view.setUint16(24, p.consts.length / 4, true);
  out[26] = p.regCount;
  out[27] = p.sensorCount;
  view.setUint16(28, p.assets.length, true);
  view.setUint32(32, tableOffset, true);
  view.setUint32(36, total, true);

  // Little-endian explicitly: the device assembles floats from bytes, so what the host's
  // own byte order happens to be must not leak into the file.
  for (let i = 0; i < p.consts.length; i++) view.setFloat32(constOffset + i * 4, p.consts[i], true);
  out.set(p.code, codeOffset);

  let at = dataOffset;
  p.assets.forEach((a, i) => {
    const e = tableOffset + i * ASSET_ENTRY_SIZE;
    view.setUint32(e, at, true);
    view.setUint32(e + 4, a.data.length, true);
    view.setUint16(e + 8, a.w, true);
    view.setUint16(e + 10, a.h, true);
    out[e + 12] = a.format;
    out.set(a.data, at);
    at += a.data.length;
  });

  return out;
}

/** What the .bin will weigh, for the editor to show before you click download. */
export function packedSize(p: Program): number {
  return (
    HEADER_SIZE +
    p.consts.length * 4 +
    p.code.length +
    p.assets.length * ASSET_ENTRY_SIZE +
    p.assets.reduce((n, a) => n + a.data.length, 0)
  );
}

/** Instruction count, which is also the per-pixel cost - the VM has no loops. */
export const instructionCount = (p: Program): number => p.code.length / INSTR_SIZE;
