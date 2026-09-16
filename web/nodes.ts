// Node library, and the instruction set every node compiles down to.
//
//   nodes.ts   what a node is, and which instruction each of its outputs becomes
//   graph.ts   graph -> Program (instructions + constants + assets), and runs one
//   pack.ts    Program -> .bin, the container the ESP32 loads
//
// The browser does not evaluate nodes. It compiles the graph to a Program and interprets
// that, which is the same Program the packer writes and the C++ VM runs - so the preview is
// the device, not an impression of it. test/crosscheck.mjs renders both and compares pixels.
//
// One value type: Vec, an [r,g,b,a] / [x,y,z,w] quad. A scalar broadcasts to [n,n,n,1] -
// opaque, so a plain number never turns invisible - and an op that wants one number reads
// component 0. Alpha is carried everywhere rather than off to the side, so an image with
// transparency stays composable all the way to Alpha Over.

export type Vec = [number, number, number, number];

// ---------------------------------------------------------------------------
// Instruction set. Mirrored in src/ProtoShadeRuntime.cpp - the numbering IS the format,
// so append, never reorder, and bump format::kVersion when you do.
// ---------------------------------------------------------------------------

export const OP = {
  UV: 0, // -> (u, v, 0, 1)
  CENTERED: 1, // aspect-corrected -1..1
  PIXEL: 2, // -> (x, y, 0, 1)
  TIME: 3, // src0 = speed
  SENSOR: 4, // aux = slot, aux2 = range << 1 | unit; src0 = value used when that slot is absent
  MATH: 5, // aux = MATH_OPS index; src0 = A, src1 = B
  MIX: 6, // src0 = fac, src1 = A, src2 = B
  OVER: 7, // src0 = fac, src1 = foreground, src2 = background
  SWIZZLE: 8, // aux = component 0..3, broadcast; src0 = vector
  COMBINE: 9, // src0..3 contribute their component 0
  HSV: 10, // src0..3 = hue, sat, val, alpha
  TEX: 11, // aux = asset, aux2 = wrap | filter << 2 | alpha-out << 3; src0 = uv
  OUTPUT: 12, // src0 = colour, src1 = brightness. Always the last instruction.
  ANIM: 13, // aux = asset, aux2 = tex flags | crossfade << 4 | loop << 5; src0 = uv, src1 = phase
  PARTICLES: 14, // aux = asset, aux2 = filter << 2; src0 = position, src1 = time, src2/src3 = params
} as const;
export type OpCode = (typeof OP)[keyof typeof OP];

/** Instruction layout: op, dst, src0..3, aux, aux2. Fixed width so validation is total. */
export const INSTR_SIZE = 8;

/**
 * An operand is one byte: a register index, or a constant-pool index with the top bit set.
 * Registers stop at 64 because the device's per-thread register file is that big (one
 * uint64_t of "written yet?" bits validates a whole program); constants get the full 7 bits.
 * Both are mirrored in format:: - raising either is a format change.
 */
export const CONST_FLAG = 0x80;
export const MAX_REGISTERS = 64;
export const MAX_CONSTS = 128;

/** Component-wise maths. Order is part of the format; unary ops ignore B. */
export const MATH_OPS = [
  "add",
  "subtract",
  "multiply",
  "divide",
  "power",
  "modulo",
  "minimum",
  "maximum",
  "greater than",
  "less than",
  "arctan2",
  "sine",
  "cosine",
  "absolute",
  "floor",
  "ceil",
  "round",
  "fraction",
  "sqrt",
  "clamp",
  "smoothstep",
] as const;

/**
 * How two colours are combined where they BOTH cover. Order is part of the format.
 * `normal` is plain source-over - the foreground simply wins - and the rest only differ
 * inside the overlap, which is the only place there are two colours to combine.
 */
export const BLEND_MODES = ["normal", "multiply", "screen", "add", "lighten", "darken", "difference"] as const;

/**
 * What happens outside the image. Order is part of the format.
 *  repeat  tiles
 *  clamp   the edge texel stretches outwards - the smear you get placing a sprite
 *  clip    nothing: transparent outside 0..1, so a sprite appears once and stops
 */
export const WRAPS = ["repeat", "clamp", "clip"] as const;

/** What a sensor reports. Order is part of the format. */
export const RANGES = ["0..1", "-1..1", "0..inf", "-inf..inf", "0..360"] as const;

/** Asset pixel formats, matching protoshade::AssetFormat. */
export const ASSET = { RGB565: 0, RGBA8888: 1, A8: 2 } as const;

/** Sprites one PROGRAM may draw, over all its emitters. Mirrors format::kMaxParticles: it is
    the size of the per-frame particle table the device keeps per rendering thread. */
export const MAX_PARTICLES = 64;

/** Constants one PARTICLES instruction reads, starting at its parameter operand. Mirrors
    format::kParticleQuads. */
export const PARTICLE_QUADS = 5;

export interface PackedAsset {
  w: number;
  /** The whole strip. One frame is h / frames rows. */
  h: number;
  format: number;
  /** Frames stacked top to bottom. 1 is a still, and a still is all a plain Image packs. */
  frames: number;
  /** Exactly the bytes that go into the .bin, and exactly what TEX samples in the preview. */
  data: Uint8Array;
}

/** A decoded upload. `packed` is cached here because converting is per-image, not per-frame. */
export interface ImageBuf {
  w: number;
  h: number;
  frames: number;
  data: Uint8ClampedArray;
  packed?: PackedAsset;
}

/** Everything a pixel knows about itself. Rebuilt per pixel, read-only. */
export interface Env {
  x: number;
  y: number;
  u: number; // pixel centre, 0..1
  v: number;
  w: number;
  h: number;
  t: number; // seconds
  frame: number;
  /**
   * Live sensor readings by slot, as the head's firmware supplies them (Frame::sensors on
   * the device). A slot with no reading falls back to the value baked into the program.
   */
  sensors?: number[];
}

export type Props = Record<string, unknown>;

export interface PropDef {
  type: "number" | "combo" | "toggle" | "image";
  value: number | string | boolean;
  options?: { values?: readonly string[]; min?: number; max?: number; step?: number };
}

/** Where an operand comes from when nothing is wired into that input. */
export type Fallback =
  | { prop: string } // the node's own widget
  | { value: number } // a literal
  | { emit: OpCode; arg?: string | number }; // synthesise an instruction - a UV for an
// unwired image, a Time for an unwired animation phase. `arg` is that instruction's own
// operand: the name of a widget to read it from, or the number itself.

export interface OutSpec {
  op: OpCode;
  aux?: (p: Props) => number;
  aux2?: (p: Props) => number;
}

export interface NodeDef {
  title: string;
  color?: string;
  desc?: string;
  /** Wired inputs, in operand order. */
  in?: string[];
  /** Parallel to `in`: what each unconnected input becomes. */
  fallback?: Fallback[];
  /** Extra operands taken straight from widgets, appended after `in`. */
  args?: string[];
  /** A block of consecutive constants, appended after `args` as ONE operand pointing at the
      first of them. Nineteen knobs do not fit in an eight-byte instruction; this is how a
      particle system carries its parameters. The block is emitted verbatim and in order -
      never deduplicated - because the VM reads it by walking forward from that operand. */
  argsBlock?: (p: Props) => Vec[];
  out: string[];
  /** One entry per output. Absent on a node that is purely a constant. */
  outs?: OutSpec[];
  /** The node IS a constant - it compiles into the pool, not into an instruction. */
  konst?: (p: Props) => Vec;
  /** TEX nodes: the compiler fills aux with the asset slot it assigned this node. */
  asset?: true;
  /** The node's input branch is rendered here in the browser and packed as a strip, and the
      node itself becomes an ANIM lookup into it. See bake.ts. */
  bake?: true;
  props?: Record<string, PropDef>;
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
const pick = (list: readonly string[], v: unknown): number => Math.max(0, list.indexOf(String(v) as never));
const slotOf = (p: Props): number => Math.max(0, Math.round(num(p.index)));
const texFlags = (p: Props): number => pick(WRAPS, p.wrap) | (p.filter === "linear" ? 4 : 0);
const animFlags = (p: Props): number => texFlags(p) | (p.crossfade ? 16 : 0) | (p.loop === false ? 0 : 32);

export const OUTPUT_TYPE = "output/led";

export const NODES: Record<string, NodeDef> = {
  "input/coordinates": {
    title: "Coordinates",
    color: "#3a5",
    desc: "Where this pixel is on the panel",
    out: ["UV", "Centered", "Pixel"],
    outs: [{ op: OP.UV }, { op: OP.CENTERED }, { op: OP.PIXEL }],
  },

  "input/time": {
    title: "Time",
    color: "#3a5",
    desc: "Seconds since boot, times speed",
    out: ["Time"],
    outs: [{ op: OP.TIME }],
    args: ["speed"],
    props: { speed: { type: "number", value: 1, options: { step: 10 } } },
  },

  "input/sensor": {
    title: "Sensor",
    color: "#3a5",
    desc: "A sensor on the head, by slot. Value is raw, Unit is that reading squashed to 0..1",
    out: ["Value", "Unit"],
    outs: [
      { op: OP.SENSOR, aux: slotOf, aux2: (p) => pick(RANGES, p.range) << 1 },
      { op: OP.SENSOR, aux: slotOf, aux2: (p) => (pick(RANGES, p.range) << 1) | 1 },
    ],
    // `test` is not a preview-only knob: it is what the shader reads when the head it runs
    // on has nothing in that slot, so it ships inside the program.
    args: ["test"],
    props: {
      range: { type: "combo", value: "0..1", options: { values: RANGES } },
      index: { type: "number", value: 0, options: { min: 0, max: 255, step: 10 } },
      test: { type: "number", value: 0.5, options: { step: 1 } },
      // Editor-only: main.ts feeds a swept reading into Env.sensors, exactly where hardware
      // readings land. The program is identical either way - only the input differs.
      sweep: { type: "toggle", value: false },
    },
  },

  "const/value": {
    title: "Value",
    color: "#666",
    out: ["Value"],
    konst: (p) => [num(p.value), num(p.value), num(p.value), 1],
    props: { value: { type: "number", value: 0.5, options: { step: 1 } } },
  },

  "const/color": {
    title: "Color",
    color: "#aa3",
    out: ["Color"],
    konst: (p) => [num(p.r), num(p.g), num(p.b), num(p.a)],
    props: {
      r: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } },
      g: { type: "number", value: 0.4, options: { min: 0, max: 1, step: 1 } },
      b: { type: "number", value: 0, options: { min: 0, max: 1, step: 1 } },
      a: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } },
    },
  },

  "math/math": {
    title: "Math",
    color: "#35a",
    desc: "Component-wise over RGB, alpha comes from A. Unary ops (sine, floor, ...) ignore B",
    in: ["A", "B"],
    fallback: [{ prop: "a" }, { prop: "b" }],
    out: ["Result"],
    outs: [{ op: OP.MATH, aux: (p) => pick(MATH_OPS, p.op) }],
    props: {
      op: { type: "combo", value: "multiply", options: { values: MATH_OPS } },
      a: { type: "number", value: 0, options: { step: 1 } },
      b: { type: "number", value: 1, options: { step: 1 } },
    },
  },

  "math/mix": {
    title: "Mix",
    color: "#35a",
    desc: "A when Fac is 0, B when Fac is 1. Alpha is blended too",
    in: ["Fac", "A", "B"],
    fallback: [{ prop: "fac" }, { value: 0 }, { value: 1 }],
    out: ["Result"],
    outs: [{ op: OP.MIX }],
    props: { fac: { type: "number", value: 0.5, options: { min: 0, max: 1, step: 1 } } },
  },

  "color/over": {
    title: "Blend",
    color: "#aa3",
    desc:
      "THE node for two things that overlap: Foreground over Background, alpha and all. " +
      "Mode says what happens inside the overlap - add for glow, multiply for shadow. " +
      "Fac fades the foreground",
    in: ["Fac", "Foreground", "Background"],
    fallback: [{ prop: "fac" }, { value: 0 }, { value: 0 }],
    out: ["Color"],
    outs: [{ op: OP.OVER, aux: (p) => pick(BLEND_MODES, p.mode) }],
    props: {
      mode: { type: "combo", value: "normal", options: { values: BLEND_MODES } },
      fac: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } },
    },
  },

  "vector/separate": {
    title: "Separate RGBA",
    color: "#63a",
    desc: "Also Separate XYZW - same four components",
    in: ["Vector"],
    fallback: [{ value: 0 }],
    out: ["R / X", "G / Y", "B / Z", "A / W"],
    outs: [0, 1, 2, 3].map((c) => ({ op: OP.SWIZZLE, aux: () => c })),
  },

  "vector/combine": {
    title: "Combine RGBA",
    color: "#63a",
    desc: "Each input contributes its first component",
    in: ["R / X", "G / Y", "B / Z", "A / W"],
    fallback: [{ prop: "r" }, { prop: "g" }, { prop: "b" }, { prop: "a" }],
    out: ["Vector"],
    outs: [{ op: OP.COMBINE }],
    props: {
      r: { type: "number", value: 0, options: { step: 1 } },
      g: { type: "number", value: 0, options: { step: 1 } },
      b: { type: "number", value: 0, options: { step: 1 } },
      a: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } },
    },
  },

  "color/hsv": {
    title: "HSV",
    color: "#aa3",
    desc: "Hue wraps, so a rising Hue is a rainbow",
    in: ["Hue", "Sat", "Val", "Alpha"],
    fallback: [{ prop: "hue" }, { prop: "sat" }, { prop: "val" }, { prop: "alpha" }],
    out: ["Color"],
    outs: [{ op: OP.HSV }],
    props: {
      hue: { type: "number", value: 0, options: { min: 0, max: 1, step: 1 } },
      sat: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } },
      val: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } },
      alpha: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } },
    },
  },

  "texture/image": {
    title: "Image",
    color: "#a63",
    desc: "Upload a PNG/JPG; it is packed into the .bin. Color carries the image's alpha",
    in: ["Vector"],
    fallback: [{ emit: OP.UV }],
    out: ["Color", "Alpha"],
    asset: true,
    outs: [
      { op: OP.TEX, aux2: texFlags },
      { op: OP.TEX, aux2: (p) => texFlags(p) | 8 },
    ],
    props: {
      file: { type: "image", value: "" },
      wrap: { type: "combo", value: "clip", options: { values: WRAPS } },
      filter: { type: "combo", value: "nearest", options: { values: ["nearest", "linear"] } },
    },
  },

  "texture/animation": {
    title: "Animation",
    color: "#a63",
    desc:
      "A strip of frames: a GIF/APNG/WebP, several PNGs at once, or one tall sprite sheet. " +
      "Phase picks the frame - wire Time for an animation, a Sensor for a blend shape",
    in: ["Vector", "Phase"],
    // Nothing wired into Phase: run it off time at the node's own speed, so an animation
    // plays the moment you drop it in.
    fallback: [{ emit: OP.UV }, { emit: OP.TIME, arg: "speed" }],
    out: ["Color", "Alpha"],
    asset: true,
    outs: [
      { op: OP.ANIM, aux2: animFlags },
      { op: OP.ANIM, aux2: (p) => animFlags(p) | 8 },
    ],
    props: {
      file: { type: "image", value: "" },
      // Set by the import, editable by hand for a sprite sheet that was already one file.
      frames: { type: "number", value: 1, options: { min: 1, max: 1024, step: 10 } },
      // loop: Phase counts whole cycles and wraps - an animation.
      // off:  Phase is 0..1 across the strip and holds at both ends - a blend shape, where
      //       0.5 means "the middle frame", not "half of frame 1 and half of frame 2".
      loop: { type: "toggle", value: true },
      // Off, a phase between two frames picks one of them. On, it dissolves between them -
      // which invents in-between images, costs a second fetch, and is usually not what a
      // blend shape wants.
      crossfade: { type: "toggle", value: false },
      speed: { type: "number", value: 1, options: { step: 10 } },
      wrap: { type: "combo", value: "clip", options: { values: WRAPS } },
      filter: { type: "combo", value: "nearest", options: { values: ["nearest", "linear"] } },
    },
  },

  "texture/particles": {
    title: "Particles",
    color: "#a63",
    desc:
      "Sprites from the image, drifting. One instruction, no state: every particle is a " +
      "function of its index and the time, so it costs flash nothing and RAM nothing",
    in: ["Vector", "Time"],
    // Centered, not UV: particles live in aspect-corrected space, so a round sprite on a
    // 64x32 panel stays round. Offset the input to move the emitter off the middle.
    fallback: [{ emit: OP.CENTERED }, { emit: OP.TIME, arg: 1 }],
    out: ["Color", "Alpha"],
    asset: true,
    outs: [
      { op: OP.PARTICLES, aux2: (p) => (p.filter === "linear" ? 4 : 0) },
      { op: OP.PARTICLES, aux2: (p) => (p.filter === "linear" ? 4 : 0) | 8 },
    ],
    // Nineteen knobs do not fit in an eight-byte instruction, so they go in the constant
    // pool as one block and the instruction points at it. Order IS the format - mirrored by
    // prepareParticles() in the C++ VM.
    argsBlock: (p) => [
      [Math.max(0, Math.round(num(p.count))), num(p.life), num(p.fade), Math.round(num(p.seed))],
      [num(p.direction), num(p.spread), num(p.speed), num(p.speedSpread)],
      [num(p.accel), num(p.gravityX), num(p.gravityY), 0],
      [num(p.size), num(p.sizeSpread), num(p.sizeRate), num(p.sizeAccel)],
      [num(p.rotation), num(p.rotSpread), num(p.rotRate), num(p.rotAccel)],
    ],
    props: {
      file: { type: "image", value: "" },
      // A strip works here too: each particle picks one frame and keeps it, so one upload
      // of several drawings is a swarm of different shapes rather than one repeated.
      frames: { type: "number", value: 1, options: { min: 1, max: 1024, step: 10 } },

      // --- emission ---
      count: { type: "number", value: 16, options: { min: 0, max: MAX_PARTICLES, step: 10 } },
      life: { type: "number", value: 2, options: { min: 0.01, max: 60, step: 1 } },
      fade: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } },
      seed: { type: "number", value: 1, options: { min: 0, max: 65535, step: 10 } },

      // --- how they leave ---
      // Degrees, read as a compass bearing: 0 is up the panel, 90 is to the right. Spread is
      // the FULL cone, so 360 really is all around and 0 is a straight line.
      direction: { type: "number", value: 0, options: { min: -360, max: 360, step: 10 } },
      spread: { type: "number", value: 60, options: { min: 0, max: 360, step: 10 } },
      speed: { type: "number", value: 0.7, options: { step: 1 } },
      speedSpread: { type: "number", value: 0.2, options: { step: 1 } },

      // --- what pushes them ---
      // accel runs along each particle's own spawn direction; gravity is the same push for
      // all of them, so it is a vector.
      accel: { type: "number", value: 0, options: { step: 1 } },
      gravityX: { type: "number", value: 0, options: { step: 1 } },
      gravityY: { type: "number", value: 0.35, options: { step: 1 } },

      // --- size over a life ---
      size: { type: "number", value: 0.28, options: { min: 0.001, max: 8, step: 1 } },
      sizeSpread: { type: "number", value: 0.08, options: { step: 1 } },
      sizeRate: { type: "number", value: 0, options: { step: 1 } },
      sizeAccel: { type: "number", value: 0, options: { step: 1 } },

      // --- rotation over a life, all in degrees ---
      rotation: { type: "number", value: 0, options: { min: -360, max: 360, step: 10 } },
      rotSpread: { type: "number", value: 0, options: { min: 0, max: 360, step: 10 } },
      rotRate: { type: "number", value: 0, options: { step: 10 } },
      rotAccel: { type: "number", value: 0, options: { step: 10 } },

      filter: { type: "combo", value: "nearest", options: { values: ["nearest", "linear"] } },
    },
  },

  "bake/bake": {
    title: "Bake",
    color: "#63a",
    desc:
      "Renders its input here in the browser, over time or over a sensor, and ships the " +
      "frames as an image. The branch above it stops costing the head anything; everything " +
      "else in the graph stays live",
    in: ["Color"],
    fallback: [{ value: 0 }],
    out: ["Color", "Alpha"],
    bake: true,
    props: {
      // What the baked strip is indexed BY. That driver stays live on the head - the frame
      // is picked per frame from the real clock or the real sensor.
      driver: { type: "combo", value: "time", options: { values: ["time", "sensor"] } },
      frames: { type: "number", value: 16, options: { min: 2, max: 256, step: 10 } },
      // driver = time: the span baked, and the period it loops over.
      seconds: { type: "number", value: 2, options: { min: 0.01, max: 600, step: 1 } },
      // driver = sensor: which slot, and what it reports. The frame is picked by that
      // reading squashed to 0..1, the same squash the Sensor node's Unit output does.
      slot: { type: "number", value: 0, options: { min: 0, max: 255, step: 10 } },
      range: { type: "combo", value: "0..1", options: { values: RANGES } },
      crossfade: { type: "toggle", value: false },
    },
  },

  [OUTPUT_TYPE]: {
    title: "LED Output",
    color: "#a33",
    desc: "What the panel shows. Exactly one of these drives the render",
    in: ["Color"],
    fallback: [{ value: 0 }],
    args: ["brightness"],
    out: [],
    // Not an output socket - this is the instruction the compiler ends the program with.
    outs: [{ op: OP.OUTPUT }],
    props: { brightness: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } } },
  },
};

// ---------------------------------------------------------------------------
// Editor side. Everything below touches the DOM or the litegraph globals, so it only runs
// in the browser - the self-check imports the tables above and nothing else.
// ---------------------------------------------------------------------------

/** Decoded uploads, by node id. Lives here because both the widget and the compiler need it. */
export const images = new Map<number, ImageBuf>();

/** One FRAME is at most 512 px a side (format::kMaxDimension); above that is dead weight in
    a flash partition. A strip of n frames is n times as tall as that, and no taller than the
    uint16 the container stores a height in. */
const MAX_IMAGE = 512;
const MAX_STRIP = 65535;

/**
 * Decode a data URL into `images`. A strip of `frames` frames stacked top to bottom - one
 * image is the frames = 1 case, which is what a plain Image node always is.
 * Rejects if the browser cannot decode it.
 */
export async function decodeInto(id: number, src: string, frames = 1): Promise<void> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const n = Math.max(1, Math.min(MAX_STRIP, Math.round(frames)));
  // Scale by the FRAME, not the strip: eight 64x64 frames is a legitimate 64x512 image, and
  // shrinking it to fit 512 overall would throw away seven eighths of the animation.
  const scale = Math.min(1, MAX_IMAGE / img.naturalWidth, (MAX_IMAGE * n) / img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  // Rounded to a whole number of frames, so a frame is an exact number of rows on both
  // sides of the wire - the runtime divides height by frames and expects no remainder.
  const rows = Math.max(1, Math.round((img.naturalHeight * scale) / n));
  const h = rows * n;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) throw new Error("2d context unavailable");
  g.drawImage(img, 0, 0, w, h);
  images.set(id, { w, h, frames: n, data: g.getImageData(0, 0, w, h).data });
}

/** What the upload button says: what is loaded, so you can see it took. */
export function imageLabel(id: number): string {
  const img = images.get(id);
  if (!img) return "upload image";
  return img.frames > 1 ? `${img.w} x ${img.h / img.frames} x ${img.frames}f` : `${img.w} x ${img.h}`;
}

/** WebCodecs, for the frames inside an animated GIF / APNG / WebP. Chrome and Edge have it;
    everywhere else an animation is still several PNGs, or one sprite sheet. */
interface ImageDecoderLike {
  tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } };
  completed: Promise<void>;
  decode(o: { frameIndex: number }): Promise<{ image: CanvasImageSource }>;
}
const ImageDecoderCtor = (globalThis as { ImageDecoder?: new (o: { data: ArrayBuffer; type: string }) => ImageDecoderLike })
  .ImageDecoder;

/** Draws `sources` into one vertical strip and returns it as a PNG data URL. */
function strip(sources: CanvasImageSource[], w: number, h: number): string {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h * sources.length;
  const g = c.getContext("2d");
  if (!g) throw new Error("2d context unavailable");
  sources.forEach((s, i) => g.drawImage(s, 0, i * h, w, h));
  return c.toDataURL("image/png");
}

/** An <img> reports naturalWidth, a decoded VideoFrame reports displayWidth. */
function sizeOf(s: CanvasImageSource): [number, number] {
  const v = s as { naturalWidth?: number; displayWidth?: number; width?: number; naturalHeight?: number; displayHeight?: number; height?: number };
  return [v.naturalWidth || v.displayWidth || Number(v.width) || 1, v.naturalHeight || v.displayHeight || Number(v.height) || 1];
}

const readDataUrl = (file: File): Promise<string> =>
  new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(file);
  });

async function decodeFile(file: File): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = await readDataUrl(file);
  await img.decode();
  return img;
}

/** Every frame of an animated file, or [] when it is not one (or the browser cannot say). */
async function animationFrames(file: File): Promise<CanvasImageSource[]> {
  if (!ImageDecoderCtor) return [];
  try {
    const decoder = new ImageDecoderCtor({ data: await file.arrayBuffer(), type: file.type });
    await decoder.tracks.ready;
    await decoder.completed; // frameCount is only final once the whole file is in
    const count = decoder.tracks.selectedTrack?.frameCount ?? 1;
    if (count < 2) return [];
    const out: CanvasImageSource[] = [];
    for (let i = 0; i < Math.min(count, MAX_STRIP); i++) out.push((await decoder.decode({ frameIndex: i })).image);
    return out;
  } catch {
    return []; // not an animation, or a codec this browser will not open
  }
}

/**
 * Ask for files and turn whatever comes back into one strip:
 *   several files    one frame each, in filename order - export a sequence from anywhere
 *   one animation    its own frames, via WebCodecs
 *   one still        a single frame, or a sprite sheet if the node's frame count says so
 * The strip is what gets saved in node.properties[key], not the originals: one data URL to
 * restore instead of n, and it is already the layout the .bin wants.
 */
function pickImage(node: LGraphNode, key: string, widget: { name: string }): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  // Only where frames mean something. Picking four files for a plain Image node would give
  // you one image four times as tall, which is nobody's intent.
  input.multiple = "frames" in node.properties;
  input.onchange = async () => {
    const files = [...(input.files ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (files.length === 0) return;
    const wantsFrames = "frames" in node.properties;
    try {
      const frames: CanvasImageSource[] =
        files.length > 1 ? await Promise.all(files.map(decodeFile)) : wantsFrames ? await animationFrames(files[0]) : [];
      let src: string;
      let count: number;
      if (frames.length > 1) {
        // Everything is drawn at the first frame's size; a sequence of mismatched images is
        // a mistake, and scaling them into line is friendlier than refusing the lot.
        const [w, h] = sizeOf(frames[0]);
        src = strip(frames, w, h);
        count = frames.length;
        // A decoded VideoFrame holds memory the garbage collector will not reclaim for you.
        for (const f of frames) (f as { close?: () => void }).close?.();
      } else {
        src = await readDataUrl(files[0]);
        // One still: honour a frame count already set on the node, so an existing sprite
        // sheet can be re-uploaded without losing how it is cut up.
        count = wantsFrames ? Math.max(1, Math.round(Number(node.properties.frames) || 1)) : 1;
      }
      await decodeInto(node.id, src, count);
      node.properties[key] = src;
      if (wantsFrames) node.setProperty("frames", count);
    } catch {
      widget.name = "decode failed";
      return;
    }
    widget.name = imageLabel(node.id);
  };
  input.click();
}

/**
 * Replace litegraph's 152 built-in node types with ours, so the right-click menu is only
 * ProtoShade nodes and a saved graph can never name one the compiler cannot emit.
 */
export function register(): void {
  LiteGraph.clearRegisteredTypes();
  for (const [type, def] of Object.entries(NODES)) {
    const Node = function (this: LGraphNode): void {
      this.properties = {};
      for (const [key, pd] of Object.entries(def.props ?? {})) this.properties[key] = pd.value;
      for (const name of def.in ?? []) this.addInput(name, "vec");
      for (const name of def.out) this.addOutput(name, "vec");
      for (const [key, pd] of Object.entries(def.props ?? {})) {
        if (pd.type === "image") {
          // A button widget draws its name, not its value, so the label is the name.
          const w = this.addWidget("button", imageLabel(this.id), "", () => pickImage(this, key, w));
        } else {
          this.addWidget(pd.type, key, pd.value, key, pd.options);
        }
      }
      if (def.color) {
        this.color = def.color;
        this.bgcolor = "#222";
      }
      // Typing a frame count re-cuts a sprite sheet that is already loaded: the strip on
      // disk does not change, only how many rows one frame is.
      if (def.props?.file && def.props?.frames) {
        this.onPropertyChanged = (name: string, value: unknown): void => {
          const src = this.properties.file;
          if (name !== "frames" || typeof src !== "string" || !src) return;
          void decodeInto(this.id, src, Number(value) || 1);
        };
      }
    } as unknown as { new (): LGraphNode; title: string; desc?: string };
    Node.title = def.title;
    Node.desc = def.desc;
    LiteGraph.registerNodeType(type, Node);
  }
}
