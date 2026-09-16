// Node library for the shader graph: one table of definitions, used twice.
//
//  - register() turns each definition into a litegraph node class (editor side)
//  - graph.ts calls def.eval() per pixel (preview side)
//
// One value type: Vec, an [r,g,b,a] / [x,y,z,w] quad. A scalar broadcasts to [n,n,n,1] -
// opaque, so a plain number never turns invisible - and a node that wants one number reads
// component 0. Blender coerces the same way, and one type keeps the evaluator free of
// dispatch. Alpha is carried everywhere rather than off to the side, so an image with
// transparency stays composable all the way to the Alpha Over node.
//
// eval() gets null for an unconnected input so the node can fall back to its own widget,
// which is what makes a bare Math node usable without wiring anything into it.

export type Vec = [number, number, number, number];

/** Decoded upload, RGBA8888, as createImageData gives it. */
export interface ImageBuf {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

/** Everything a pixel knows about itself. Rebuilt per pixel, read-only to nodes. */
export interface Env {
  x: number; // pixel column, 0..w-1
  y: number; // pixel row, 0..h-1
  u: number; // x normalised to 0..1 (pixel centre)
  v: number;
  w: number;
  h: number;
  t: number; // seconds since the page loaded
  frame: number;
  images: Map<number, ImageBuf>; // by node id, filled by decodeInto()
  /**
   * Live sensor readings by index, as the head's firmware will supply them. Absent in the
   * browser, where nothing is plugged in - Sensor nodes then fall back to their own test
   * widget, so the seam is already here for when a real feed arrives.
   */
  sensors?: number[];
}

/** A node's widget values, straight off LGraphNode.properties. */
export type Props = Record<string, unknown>;

export interface PropDef {
  type: "number" | "combo" | "toggle" | "image";
  value: number | string | boolean;
  options?: { values?: string[]; min?: number; max?: number; step?: number };
}

export interface NodeDef {
  title: string;
  in?: string[];
  out: string[];
  props?: Record<string, PropDef>;
  color?: string;
  desc?: string;
  /** One output Vec per entry in `out`. Extra params are optional - omit what you ignore. */
  eval(inp: (Vec | null)[], p: Props, env: Env, id: number): Vec[];
}

const vec = (n: number): Vec => [n, n, n, 1];
/** Component-wise over RGB; alpha rides through from `a`. Scaling a colour must not
    change its coverage, and a scalar B broadcasts to alpha 1 which add/divide would ruin. */
const rgb2 = (a: Vec, b: Vec, f: Op): Vec => [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2]), a[3]];
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
/** Unconnected input -> the node's own widget value, broadcast. */
const fb = (v: Vec | null, p: Props, key: string): Vec => v ?? vec(num(p[key]));
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// Component-wise math. Unary entries ignore B, which is why arity is tracked separately:
// the editor greys nothing out, but B simply has no effect and that is documented per op.
type Op = (a: number, b: number) => number;
export const OPS: Record<string, Op> = {
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
  // Zero denominators come from live widgets and unconnected inputs, not from bugs:
  // returning 0 keeps Infinity/NaN out of the pixel buffer, where they render as black
  // holes that are hard to trace back here.
  divide: (a, b) => (b === 0 ? 0 : a / b),
  power: (a, b) => (a < 0 ? 0 : Math.pow(a, b)),
  // Floored modulo, so mod(-0.25, 1) is 0.75 and a scrolling coordinate stays continuous
  // when it crosses zero. JS's % would give -0.25 and tear the pattern.
  modulo: (a, b) => (b === 0 ? 0 : a - Math.floor(a / b) * b),
  minimum: (a, b) => Math.min(a, b),
  maximum: (a, b) => Math.max(a, b),
  "greater than": (a, b) => (a > b ? 1 : 0),
  "less than": (a, b) => (a < b ? 1 : 0),
  arctan2: (a, b) => Math.atan2(a, b),
  sine: (a) => Math.sin(a),
  cosine: (a) => Math.cos(a),
  absolute: (a) => Math.abs(a),
  floor: (a) => Math.floor(a),
  ceil: (a) => Math.ceil(a),
  round: (a) => Math.round(a),
  fraction: (a) => a - Math.floor(a),
  sqrt: (a) => (a < 0 ? 0 : Math.sqrt(a)),
  clamp: (a) => clamp01(a),
  // Shaping curve on 0..1. Scale/offset A first (subtract + divide) to place the ramp.
  smoothstep: (a) => {
    const x = clamp01(a);
    return x * x * (3 - 2 * x);
  },
};
export const OP_NAMES = Object.keys(OPS);

const hsvToRgb = (h: number, s: number, v: number, a: number): Vec => {
  const hh = (h - Math.floor(h)) * 6;
  const c = clamp01(v) * clamp01(s);
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = clamp01(v) - c;
  const i = Math.floor(hh) % 6;
  const t: [number, number, number] =
    i === 0 ? [c, x, 0] : i === 1 ? [x, c, 0] : i === 2 ? [0, c, x] : i === 3 ? [0, x, c] : i === 4 ? [x, 0, c] : [c, 0, x];
  return [t[0] + m, t[1] + m, t[2] + m, a];
};

/**
 * What a sensor reports, and how to squash it into 0..1. The range is the sensor's own
 * format - a flex sensor gives 0..1, an encoder counts up forever, an IMU axis swings both
 * ways - so the node declares it instead of pretending everything is already normalised.
 * `unit` is what makes an unbounded reading usable as a hue or a mix factor: it saturates
 * instead of clipping, so a value of 3 and a value of 300 still look different.
 */
const RANGES: Record<string, { unit: (x: number) => number; sweep: (t: number) => number }> = {
  "0..1": { unit: clamp01, sweep: (t) => 0.5 - 0.5 * Math.cos(t) },
  "-1..1": { unit: (x) => clamp01(x * 0.5 + 0.5), sweep: (t) => Math.sin(t) },
  "0..inf": { unit: (x) => (x <= 0 ? 0 : x / (1 + x)), sweep: (t) => 5 - 5 * Math.cos(t) },
  "-inf..inf": { unit: (x) => 0.5 + (0.5 * x) / (1 + Math.abs(x)), sweep: (t) => 5 * Math.sin(t) },
  // Degrees wrap rather than clamp: at 359 deg a head is a degree from 0, not at the far end.
  "0..360": { unit: (x) => (((x % 360) + 360) % 360) / 360, sweep: (t) => ((t * 60) % 360) },
};
const RANGE_NAMES = Object.keys(RANGES);

export const OUTPUT_TYPE = "output/led";

export const NODES: Record<string, NodeDef> = {
  "input/coordinates": {
    title: "Coordinates",
    color: "#3a5",
    desc: "Where this pixel is on the panel",
    out: ["UV", "Centered", "Pixel"],
    eval: (_i, _p, env) => [
      [env.u, env.v, 0, 1],
      // Aspect-corrected -1..1, so a circle on a 64x32 panel stays round.
      [(env.u * 2 - 1) * (env.w / Math.max(env.h, 1)), env.v * 2 - 1, 0, 1],
      [env.x, env.y, 0, 1],
    ],
  },

  "input/time": {
    title: "Time",
    color: "#3a5",
    desc: "Seconds since load, times speed",
    out: ["Time"],
    props: { speed: { type: "number", value: 1, options: { step: 10 } } },
    eval: (_i, p, env) => [vec(env.t * num(p.speed))],
  },

  "input/sensor": {
    title: "Sensor",
    color: "#3a5",
    desc: "A sensor on the head, by index. Value is raw, Unit is that value squashed to 0..1",
    out: ["Value", "Unit"],
    props: {
      range: { type: "combo", value: "0..1", options: { values: RANGE_NAMES } },
      index: { type: "number", value: 0, options: { min: 0, max: 255, step: 10 } },
      // No hardware is attached to a browser, so the editor drives the node itself:
      // `test` holds a reading, `sweep` walks the range so you can watch it animate.
      test: { type: "number", value: 0.5, options: { step: 1 } },
      sweep: { type: "toggle", value: false },
    },
    eval: (_i, p, env) => {
      const r = RANGES[String(p.range)] ?? RANGES["0..1"];
      // Index is a widget: round it, floor it at 0, and read past the end as 0 rather
      // than letting a typo hand undefined to the maths.
      const live = env.sensors?.[Math.max(0, Math.round(num(p.index)))];
      const raw = live ?? (p.sweep ? r.sweep(env.t * 1.5) : num(p.test));
      return [vec(raw), vec(r.unit(raw))];
    },
  },

  "const/value": {
    title: "Value",
    color: "#666",
    out: ["Value"],
    props: { value: { type: "number", value: 0.5, options: { step: 1 } } },
    eval: (_i, p) => [vec(num(p.value))],
  },

  "const/color": {
    title: "Color",
    color: "#aa3",
    out: ["Color"],
    props: {
      r: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } },
      g: { type: "number", value: 0.4, options: { min: 0, max: 1, step: 1 } },
      b: { type: "number", value: 0, options: { min: 0, max: 1, step: 1 } },
      a: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } },
    },
    eval: (_i, p) => [[num(p.r), num(p.g), num(p.b), num(p.a)]],
  },

  "math/math": {
    title: "Math",
    color: "#35a",
    desc: "Component-wise over RGB, alpha comes from A. Unary ops (sine, floor, ...) ignore B",
    in: ["A", "B"],
    out: ["Result"],
    props: {
      op: { type: "combo", value: "multiply", options: { values: OP_NAMES } },
      a: { type: "number", value: 0, options: { step: 1 } },
      b: { type: "number", value: 1, options: { step: 1 } },
    },
    eval: (inp, p) => [rgb2(fb(inp[0], p, "a"), fb(inp[1], p, "b"), OPS[String(p.op)] ?? OPS.add)],
  },

  "math/mix": {
    title: "Mix",
    color: "#35a",
    desc: "A when Fac is 0, B when Fac is 1. Alpha is blended too",
    in: ["Fac", "A", "B"],
    out: ["Result"],
    props: { fac: { type: "number", value: 0.5, options: { min: 0, max: 1, step: 1 } } },
    eval: (inp, p) => {
      const f = fb(inp[0], p, "fac")[0];
      const a = inp[1] ?? vec(0);
      const b = inp[2] ?? vec(1);
      const l = (i: number): number => a[i] + (b[i] - a[i]) * f;
      return [[l(0), l(1), l(2), l(3)]];
    },
  },

  "color/over": {
    title: "Alpha Over",
    color: "#aa3",
    desc: "Foreground composited over Background, source-over. Fac fades the foreground",
    in: ["Fac", "Foreground", "Background"],
    out: ["Color"],
    props: { fac: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } } },
    eval: (inp, p) => {
      const fg = inp[1] ?? vec(0);
      const bg = inp[2] ?? vec(0);
      const af = clamp01(fg[3]) * clamp01(fb(inp[0], p, "fac")[0]);
      const ab = clamp01(bg[3]);
      const a = af + ab * (1 - af);
      // Straight (un-premultiplied) alpha in and out, so chaining two of these composes.
      // Fully transparent result: the colour is meaningless, keep it black instead of 0/0.
      if (a === 0) return [[0, 0, 0, 0]];
      const c = (i: number): number => (fg[i] * af + bg[i] * ab * (1 - af)) / a;
      return [[c(0), c(1), c(2), a]];
    },
  },

  "vector/separate": {
    title: "Separate RGBA",
    color: "#63a",
    desc: "Also Separate XYZW - same four components",
    in: ["Vector"],
    out: ["R / X", "G / Y", "B / Z", "A / W"],
    eval: (inp) => {
      const a = inp[0] ?? vec(0);
      return [vec(a[0]), vec(a[1]), vec(a[2]), vec(a[3])];
    },
  },

  "vector/combine": {
    title: "Combine RGBA",
    color: "#63a",
    desc: "Each input contributes its first component",
    in: ["R / X", "G / Y", "B / Z", "A / W"],
    out: ["Vector"],
    props: {
      r: { type: "number", value: 0, options: { step: 1 } },
      g: { type: "number", value: 0, options: { step: 1 } },
      b: { type: "number", value: 0, options: { step: 1 } },
      a: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } },
    },
    eval: (inp, p) => [
      [
        fb(inp[0], p, "r")[0],
        fb(inp[1], p, "g")[0],
        fb(inp[2], p, "b")[0],
        fb(inp[3], p, "a")[0],
      ],
    ],
  },

  "color/hsv": {
    title: "HSV",
    color: "#aa3",
    desc: "Hue wraps, so a rising Hue is a rainbow",
    in: ["Hue", "Sat", "Val", "Alpha"],
    out: ["Color"],
    props: {
      hue: { type: "number", value: 0, options: { min: 0, max: 1, step: 1 } },
      sat: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } },
      val: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } },
      alpha: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } },
    },
    eval: (inp, p) => [
      hsvToRgb(
        fb(inp[0], p, "hue")[0],
        fb(inp[1], p, "sat")[0],
        fb(inp[2], p, "val")[0],
        fb(inp[3], p, "alpha")[0],
      ),
    ],
  },

  "texture/image": {
    title: "Image",
    color: "#a63",
    desc: "Upload a PNG/JPG and sample it with a UV vector. Color carries the PNG's alpha",
    in: ["Vector"],
    out: ["Color", "Alpha"],
    props: {
      file: { type: "image", value: "" },
      wrap: { type: "combo", value: "repeat", options: { values: ["repeat", "clamp"] } },
      filter: { type: "combo", value: "nearest", options: { values: ["nearest", "linear"] } },
    },
    eval: (inp, p, env, id) => {
      const img = env.images.get(id);
      // No upload yet: transparent, so an Alpha Over below it shows the background
      // instead of a black rectangle.
      if (!img) return [[0, 0, 0, 0], vec(0)];
      const uv = inp[0] ?? [env.u, env.v, 0, 1];
      const px = sampleImage(img, uv[0], uv[1], String(p.wrap), String(p.filter));
      return [px, vec(px[3])];
    },
  },

  [OUTPUT_TYPE]: {
    title: "LED Output",
    color: "#a33",
    desc: "What the panel shows. Exactly one of these drives the preview",
    in: ["Color"],
    out: [],
    props: { brightness: { type: "number", value: 1, options: { min: 0, max: 1, step: 1 } } },
    eval: (inp, p) => {
      // An LED is on or off, there is nothing behind it to show through: alpha composites
      // against black here, which is the one place transparency has to be resolved.
      const c = inp[0] ?? vec(0);
      const k = num(p.brightness) * clamp01(c[3]);
      return [[clamp01(c[0] * k), clamp01(c[1] * k), clamp01(c[2] * k), 1]];
    },
  },
};

/** RGBA in 0..1 at uv. Nearest by default - an LED panel has no pixels to spare on blur. */
function sampleImage(img: ImageBuf, u: number, v: number, wrap: string, filter: string): Vec {
  const fold = (t: number, n: number): number =>
    wrap === "clamp" ? Math.min(Math.max(t, 0), n - 1) : ((t % n) + n) % n;
  const texel = (xi: number, yi: number): Vec => {
    const i = (fold(yi, img.h) * img.w + fold(xi, img.w)) * 4;
    return [img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255, img.data[i + 3] / 255];
  };
  if (filter !== "linear") return texel(Math.floor(u * img.w), Math.floor(v * img.h));

  const x = u * img.w - 0.5;
  const y = v * img.h - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const a = texel(x0, y0);
  const b = texel(x0 + 1, y0);
  const c = texel(x0, y0 + 1);
  const d = texel(x0 + 1, y0 + 1);
  const lerp = (p: number, q: number, t: number): number => p + (q - p) * t;
  const at = (k: number): number => lerp(lerp(a[k], b[k], fx), lerp(c[k], d[k], fx), fy);
  return [at(0), at(1), at(2), at(3)];
}

// ---------------------------------------------------------------------------
// Editor side. Everything below touches the DOM or the litegraph globals, so it
// only runs in the browser - the self-check imports the table above and nothing else.
// ---------------------------------------------------------------------------

/** Decoded uploads, by node id. Lives here because both the widget and Env need it. */
export const images = new Map<number, ImageBuf>();

/** The panel is at most 512px wide (format::kMaxDimension); anything above that is waste. */
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

/** Ask for a file, decode it, and store the data URL in node.properties[key] so it
    survives a reload. */
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
 * Replace litegraph's 152 built-in node types with ours, so the right-click menu is
 * only ProtoShade nodes and a saved graph can never reference a node we cannot evaluate.
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
