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

export interface PackedAsset {
  w: number;
  h: number;
  format: number;
  /** Exactly the bytes that go into the .bin, and exactly what TEX samples in the preview. */
  data: Uint8Array;
}

/** A decoded upload. `packed` is cached here because converting is per-image, not per-frame. */
export interface ImageBuf {
  w: number;
  h: number;
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
  | { uv: true }; // synthesise a UV instruction (only the Image node needs this)

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
  out: string[];
  /** One entry per output. Absent on a node that is purely a constant. */
  outs?: OutSpec[];
  /** The node IS a constant - it compiles into the pool, not into an instruction. */
  konst?: (p: Props) => Vec;
  /** TEX nodes: the compiler fills aux with the asset slot it assigned this node. */
  asset?: true;
  props?: Record<string, PropDef>;
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
const pick = (list: readonly string[], v: unknown): number => Math.max(0, list.indexOf(String(v) as never));
const slotOf = (p: Props): number => Math.max(0, Math.round(num(p.index)));
const texFlags = (p: Props): number => pick(WRAPS, p.wrap) | (p.filter === "linear" ? 4 : 0);

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
    title: "Alpha Over",
    color: "#aa3",
    desc: "Foreground composited over Background, source-over. Fac fades the foreground",
    in: ["Fac", "Foreground", "Background"],
    fallback: [{ prop: "fac" }, { value: 0 }, { value: 0 }],
    out: ["Color"],
    outs: [{ op: OP.OVER }],
    props: { fac: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } } },
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
    fallback: [{ uv: true }],
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

/** The panel is at most 512 px a side (format::kMaxDimension); above that is dead weight in
    a flash partition. */
const MAX_IMAGE = 512;

/** Decode a data URL into `images`. Rejects if the browser cannot decode it. */
export async function decodeInto(id: number, src: string): Promise<void> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const scale = Math.min(1, MAX_IMAGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) throw new Error("2d context unavailable");
  g.drawImage(img, 0, 0, w, h);
  images.set(id, { w, h, data: g.getImageData(0, 0, w, h).data });
}

/** What the Image node's button says: the decoded size, so you can see what is loaded. */
export function imageLabel(id: number): string {
  const img = images.get(id);
  return img ? `${img.w} x ${img.h}` : "upload image";
}

/** Ask for a file, decode it, and keep the data URL in node.properties[key] for the save. */
function pickImage(node: LGraphNode, key: string, widget: { name: string }): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const src = await new Promise<string>((ok, fail) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.onerror = () => fail(r.error);
      r.readAsDataURL(file);
    });
    try {
      await decodeInto(node.id, src);
    } catch {
      widget.name = "decode failed";
      return;
    }
    node.properties[key] = src;
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
    } as unknown as { new (): LGraphNode; title: string; desc?: string };
    Node.title = def.title;
    Node.desc = def.desc;
    LiteGraph.registerNodeType(type, Node);
  }
}
