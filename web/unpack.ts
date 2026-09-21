// .bin -> a graph, the other direction from pack.ts.
//
// The instruction set was built with one instruction per used node output, so a program
// carries enough structure to be read back as nodes and wires: the op says which node, aux
// says which of its widgets, and the register an operand names says which node fed it. What
// is NOT in the file is where the boxes sat on the canvas and what the constants were called
// in the graph that produced them, so the layout here is computed and a scalar operand comes
// back as a widget value rather than as whatever node originally produced it.
//
// It is therefore a lossless round trip of the PROGRAM, not of the graph: import a .bin,
// download it again, and the head renders the same pixels. test/unpack.test.mjs holds that
// for every example, by rendering both and comparing.

import {
  ASSET,
  BLEND_MODES,
  CONST_FLAG,
  INSTR_SIZE,
  MATH_OPS,
  NODES,
  OP,
  OUTPUT_TYPE,
  RANGES,
  WRAPS,
  type ImageBuf,
  type Props,
  type Vec,
} from "./nodes.js";
import { ASSET_ENTRY_SIZE, FORMAT_VERSION, HEADER_SIZE } from "./pack.js";
import type { Art, Example } from "./examples.js";

export interface Imported {
  /** The same shape an example is, so examples.ts can put it in the editor unchanged. */
  example: Example;
  /** Decoded art by node id - what `images` holds after an upload, for a headless compile. */
  images: Map<number, ImageBuf>;
  width: number;
  height: number;
}

/** op -> the node type that emits it. The three coordinate ops share one node, as do the
    two outputs of a texture, which is why the slot is worked out separately below. */
const TYPE_OF: Record<number, string> = {
  [OP.UV]: "input/coordinates",
  [OP.CENTERED]: "input/coordinates",
  [OP.PIXEL]: "input/coordinates",
  [OP.TIME]: "input/time",
  [OP.SENSOR]: "input/sensor",
  [OP.MATH]: "math/math",
  [OP.MIX]: "math/mix",
  [OP.OVER]: "color/over",
  [OP.SWIZZLE]: "vector/separate",
  [OP.COMBINE]: "vector/combine",
  [OP.HSV]: "color/hsv",
  [OP.TEX]: "texture/image",
  [OP.ANIM]: "texture/animation",
  [OP.PARTICLES]: "texture/particles",
  [OP.OUTPUT]: OUTPUT_TYPE,
};

interface Instr {
  op: number;
  dst: number;
  src: number[];
  aux: number;
  aux2: number;
}

interface RawAsset {
  w: number;
  h: number;
  frames: number;
  format: number;
  data: Uint8Array;
}

const bad = (why: string): never => {
  throw new Error(why);
};

/** A constant that came from a scalar widget: broadcast over RGB, opaque. */
const isScalar = (c: Vec): boolean => c[0] === c[1] && c[1] === c[2] && c[3] === 1;

export function unpack(bytes: Uint8Array): Imported {
  if (bytes.length < HEADER_SIZE) bad("not a ProtoShade .bin - too short to hold a header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "PSHD") bad("not a ProtoShade .bin - wrong magic");
  const version = view.getUint16(4, true);
  if (version !== FORMAT_VERSION) {
    bad(`this .bin is format version ${version}, the editor writes ${FORMAT_VERSION}`);
  }
  if (view.getUint32(36, true) !== bytes.length) bad("truncated .bin - the length in the header is not the file's");

  const width = view.getUint16(8, true) || 64;
  const height = view.getUint16(10, true) || 32;
  const codeAt = view.getUint32(12, true);
  const codeLen = view.getUint32(16, true);
  const constAt = view.getUint32(20, true);
  const constCount = view.getUint16(24, true);
  const assetCount = view.getUint16(28, true);
  const tableAt = view.getUint32(32, true);
  const inside = (off: number, len: number): boolean => off + len <= bytes.length && off >= 0 && len >= 0;
  if (!inside(codeAt, codeLen) || codeLen % INSTR_SIZE !== 0) bad("the code section is outside the file");
  if (!inside(constAt, constCount * 16)) bad("the constant pool is outside the file");
  if (!inside(tableAt, assetCount * ASSET_ENTRY_SIZE)) bad("the asset table is outside the file");

  const consts: Vec[] = [];
  for (let i = 0; i < constCount; i++) {
    const o = constAt + i * 16;
    consts.push([0, 4, 8, 12].map((d) => view.getFloat32(o + d, true)) as unknown as Vec);
  }

  const assets: RawAsset[] = [];
  for (let i = 0; i < assetCount; i++) {
    const e = tableAt + i * ASSET_ENTRY_SIZE;
    const off = view.getUint32(e, true);
    const len = view.getUint32(e + 4, true);
    if (!inside(off, len)) bad(`asset ${i} is outside the file`);
    assets.push({
      w: view.getUint16(e + 8, true),
      h: view.getUint16(e + 10, true),
      format: bytes[e + 12],
      frames: Math.max(1, view.getUint16(e + 13, true)),
      data: bytes.subarray(off, off + len),
    });
  }

  const instrs: Instr[] = [];
  for (let i = 0; i < codeLen / INSTR_SIZE; i++) {
    const o = codeAt + i * INSTR_SIZE;
    if (!(bytes[o] in TYPE_OF)) bad(`unknown opcode ${bytes[o]} at instruction ${i}`);
    instrs.push({
      op: bytes[o],
      dst: bytes[o + 1],
      src: [bytes[o + 2], bytes[o + 3], bytes[o + 4], bytes[o + 5]],
      aux: bytes[o + 6],
      aux2: bytes[o + 7],
    });
  }
  if (instrs.length === 0 || instrs[instrs.length - 1].op !== OP.OUTPUT) {
    bad("this .bin does not end in an LED Output - it is not a whole program");
  }

  // ---- instructions -> nodes -------------------------------------------------------
  //
  // One node per instruction, except where several instructions are two outputs of the same
  // box: a texture's Colour and Alpha differ only in bit 3 of aux2, the four components of a
  // Separate share their input, and every coordinate op is one Coordinates node.

  /** Which node produced each instruction, and out of which of its output slots. */
  const owner: { node: number; slot: number }[] = [];
  const nodes: { id: number; type: string; pos: [number, number]; props: Props }[] = [];
  const byKey = new Map<string, number>();
  let nextId = 1;

  const keyOf = (n: Instr): string | null => {
    switch (n.op) {
      case OP.UV:
      case OP.CENTERED:
      case OP.PIXEL:
        return "coords";
      case OP.SWIZZLE:
        return `separate:${n.src[0]}`;
      case OP.SENSOR:
        return `sensor:${n.aux}:${n.aux2 >> 1}:${n.src[0]}`;
      // The alpha-out bit is which SOCKET was used, not a different texture.
      case OP.TEX:
      case OP.ANIM:
      case OP.PARTICLES:
        return `tex:${n.op}:${n.aux}:${n.aux2 & ~8}:${n.src.join(",")}`;
      default:
        return null; // every other op is a node of its own
    }
  };

  const slotOf = (n: Instr): number => {
    switch (n.op) {
      case OP.CENTERED:
        return 1;
      case OP.PIXEL:
        return 2;
      case OP.SWIZZLE:
        return n.aux & 3;
      case OP.SENSOR:
        return n.aux2 & 1;
      case OP.TEX:
      case OP.ANIM:
      case OP.PARTICLES:
        return n.aux2 & 8 ? 1 : 0;
      default:
        return 0;
    }
  };

  instrs.forEach((n, i) => {
    const key = keyOf(n);
    const seen = key === null ? undefined : byKey.get(key);
    if (seen !== undefined) {
      owner[i] = { node: seen, slot: slotOf(n) };
      return;
    }
    const id = nextId++;
    nodes.push({ id, type: TYPE_OF[n.op], pos: [0, 0], props: {} });
    if (key !== null) byKey.set(key, id);
    owner[i] = { node: id, slot: slotOf(n) };
  });

  /** Register -> the instruction that wrote it. Every register is written exactly once. */
  const producer: number[] = [];
  instrs.forEach((n, i) => (producer[n.dst] = i));

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const links: [number, number, number, number][] = [];
  const images = new Map<number, ImageBuf>();

  /** Makes the node a non-scalar constant needs, and returns it. */
  function constNode(c: Vec): number {
    const id = nextId++;
    const props: Props = isScalar(c)
      ? { value: c[0] }
      : { r: c[0], g: c[1], b: c[2], a: c[3] };
    nodes.push({ id, type: isScalar(c) ? "const/value" : "const/color", pos: [0, 0], props });
    nodeById.set(id, nodes[nodes.length - 1]);
    return id;
  }

  // ---- widgets and wires -----------------------------------------------------------

  instrs.forEach((n, i) => {
    const mine = owner[i];
    const node = nodeById.get(mine.node)!;
    const def = NODES[node.type];
    const props = node.props;

    // Operand layout is the compiler's: the wired inputs first, then one scalar per entry in
    // `args`, then the operand pointing at an argsBlock.
    const inputs = def.in?.length ?? 0;
    for (let s = 0; s < inputs; s++) {
      const operand = n.src[s];
      const fb = def.fallback?.[s];
      if (operand & CONST_FLAG) {
        const c = consts[operand & ~CONST_FLAG];
        if (!c) continue;
        // A widget's own value, so it comes back as that widget rather than as a node.
        if (fb && "prop" in fb && isScalar(c)) {
          props[fb.prop] = c[0];
          continue;
        }
        // Already the socket's default: leave it empty, the way it was drawn.
        if (fb && "value" in fb && isScalar(c) && c[0] === fb.value) continue;
        links.push([constNode(c), 0, node.id, s]);
        continue;
      }
      const from = producer[operand];
      // A read of a register nothing wrote cannot happen in a program the device accepted,
      // but this file also parses ones it did not: treat it as an empty socket.
      if (from === undefined || from >= i) continue;
      links.push([owner[from].node, owner[from].slot, node.id, s]);
    }

    (def.args ?? []).forEach((name, k) => {
      const operand = n.src[inputs + k];
      const c = operand & CONST_FLAG ? consts[operand & ~CONST_FLAG] : undefined;
      if (c) props[name] = c[0];
    });

    switch (n.op) {
      case OP.MATH:
        props.op = MATH_OPS[n.aux] ?? MATH_OPS[0];
        break;
      case OP.OVER:
        props.mode = BLEND_MODES[n.aux] ?? BLEND_MODES[0];
        break;
      case OP.SENSOR:
        props.index = n.aux;
        props.range = RANGES[n.aux2 >> 1] ?? RANGES[0];
        break;
      case OP.TEX:
      case OP.ANIM:
      case OP.PARTICLES:
        readTexture(n, node.id, props);
        break;
      default:
        break;
    }
  });

  /** The knobs that live in aux2 and in the asset table, plus the art itself. */
  function readTexture(n: Instr, id: number, props: Props): void {
    const a = assets[n.aux];
    if (n.op !== OP.PARTICLES) {
      props.wrap = WRAPS[n.aux2 & 3] ?? WRAPS[0];
    }
    props.filter = n.aux2 & 4 ? "linear" : "nearest";
    if (n.op === OP.ANIM) {
      props.crossfade = (n.aux2 & 16) !== 0;
      props.loop = (n.aux2 & 32) !== 0;
    }
    if (n.op === OP.PARTICLES) readParticles(n, props);
    if (!a) return;
    props.frames = a.frames;
    images.set(id, toImage(a));
  }

  /** The five-quad parameter block, in the order argsBlock() writes it. */
  function readParticles(n: Instr, props: Props): void {
    const base = n.src[2] & CONST_FLAG ? n.src[2] & ~CONST_FLAG : -1;
    const q = (k: number): Vec => consts[base + k] ?? [0, 0, 0, 0];
    if (base < 0 || !consts[base + 4]) return;
    const names: string[][] = [
      ["count", "life", "fade", "seed"],
      ["direction", "spread", "speed", "speedSpread"],
      ["accel", "gravityX", "gravityY", ""],
      ["size", "sizeSpread", "sizeRate", "sizeAccel"],
      ["rotation", "rotSpread", "rotRate", "rotAccel"],
    ];
    names.forEach((row, k) => row.forEach((name, c) => name && (props[name] = q(k)[c])));
  }

  // ---- layout ----------------------------------------------------------------------
  //
  // Longest path from the inputs, so a wire always runs left to right. Nothing here knows
  // how wide a node draws, so the columns are generous rather than tight.

  const feeds = new Map<number, number[]>();
  for (const [from, , to] of links) feeds.set(to, [...(feeds.get(to) ?? []), from]);
  const depth = new Map<number, number>();
  const depthOf = (id: number, seen = new Set<number>()): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = Math.max(0, ...(feeds.get(id) ?? []).map((f) => depthOf(f, seen) + 1));
    depth.set(id, d);
    return d;
  };
  const column = new Map<number, number>();
  for (const node of nodes) {
    const d = depthOf(node.id);
    const row = column.get(d) ?? 0;
    column.set(d, row + 1);
    node.pos = [40 + d * 240, 40 + row * 150];
  }

  return {
    example: {
      name: "imported",
      desc: `imported from a .bin: ${instrs.length} instructions, ${assets.length} image${assets.length === 1 ? "" : "s"}, authored at ${width}x${height}`,
      nodes,
      links,
      art: Object.fromEntries([...images].map(([id, img]) => [id, artOf(img)])),
    },
    images,
    width,
    height,
  };
}

/** An asset back to the RGBA the editor keeps uploads in. The expansion of a 565 is the one
    that packs back to the same 565, so a round trip through here changes no pixel. */
function toImage(a: RawAsset): ImageBuf {
  const px = a.w * a.h;
  const out = new Uint8ClampedArray(px * 4);
  for (let i = 0; i < px; i++) {
    if (a.format === ASSET.RGBA8888) {
      out.set(a.data.subarray(i * 4, i * 4 + 4), i * 4);
    } else if (a.format === ASSET.A8) {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255;
      out[i * 4 + 3] = a.data[i] ?? 0;
    } else {
      const v = (a.data[i * 2] ?? 0) | ((a.data[i * 2 + 1] ?? 0) << 8);
      const r = (v >> 11) & 31;
      const g = (v >> 5) & 63;
      const b = v & 31;
      out[i * 4] = (r << 3) | (r >> 2);
      out[i * 4 + 1] = (g << 2) | (g >> 4);
      out[i * 4 + 2] = (b << 3) | (b >> 2);
      out[i * 4 + 3] = 255;
    }
  }
  return { w: a.w, h: a.h, frames: a.frames, data: out };
}

/** Wraps decoded pixels as an Art, so examples.ts can load them exactly like drawn art.
    Through a canvas rather than putImageData, which ignores the transform and the clip the
    strip is drawn under - a frame has to land at the offset drawStrip() translated to. */
function artOf(img: ImageBuf): Art {
  const rows = Math.max(1, Math.floor(img.h / Math.max(1, img.frames)));
  let strip: HTMLCanvasElement | null = null;
  return {
    w: img.w,
    h: rows,
    frames: img.frames,
    draw(g, w, h, frame) {
      if (!strip) {
        strip = document.createElement("canvas");
        strip.width = img.w;
        strip.height = img.h;
        const pixels = new ImageData(img.w, img.h);
        pixels.data.set(img.data);
        strip.getContext("2d")?.putImageData(pixels, 0, 0);
      }
      g.drawImage(strip, 0, frame * rows, w, h, 0, 0, w, h);
    },
  };
}
