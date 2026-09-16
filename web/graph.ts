// Compiles a node graph into a Program, and interprets one.
//
// A Program is straight-line code: no jumps, no loops, one instruction per used node output,
// in an order where every operand was written before it is read. That is what makes it safe
// to run on a head - the cost of a pixel is known before the first one is drawn - and it is
// why the C++ VM is a switch in a for loop rather than a machine with a stack.
//
// compile() reads the live LGraph object rather than graph.serialize(): same fields, no deep
// clone, cheap enough to redo every frame so the editor needs no dirty tracking at all. The
// shape it needs is small enough to write by hand, which is how the tests build graphs.

import {
  ASSET,
  CONST_FLAG,
  INSTR_SIZE,
  MATH_OPS,
  MAX_CONSTS,
  MAX_REGISTERS,
  NODES,
  OP,
  OUTPUT_TYPE,
  RANGES,
  type Env,
  type Fallback,
  type ImageBuf,
  type PackedAsset,
  type Props,
  type Vec,
} from "./nodes.js";

export interface LinkLike {
  origin_id: number;
  origin_slot: number;
}

export interface NodeLike {
  id: number;
  type: string;
  properties: Props;
  inputs?: { link: number | null }[];
}

export interface GraphLike {
  _nodes: NodeLike[];
  links: Record<number, LinkLike | null | undefined>;
}

export interface Program {
  /** INSTR_SIZE bytes each: op, dst, src0..3, aux, aux2. */
  code: Uint8Array;
  /** Four floats each, indexed by an operand with CONST_FLAG set. */
  consts: Float32Array;
  regCount: number;
  /** Highest sensor slot used, plus one. The device checks its feed against this. */
  sensorCount: number;
  assets: PackedAsset[];
  /** Resolution the graph was authored at, for whoever loads the .bin. */
  width: number;
  height: number;
}

export type CompileResult = { ok: true; program: Program } | { ok: false; reason: string };

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

export function compile(graph: GraphLike, images: Map<number, ImageBuf>, w = 64, h = 32): CompileResult {
  const out = graph._nodes.find((n) => n.type === OUTPUT_TYPE);
  if (!out) return { ok: false, reason: "no LED Output node - add one and wire a colour into it" };

  const byId = new Map(graph._nodes.map((n) => [n.id, n]));
  const code: number[] = [];
  const consts: number[] = [];
  const constKeys = new Map<string, number>();
  const assets: PackedAsset[] = [];
  const assetOf = new Map<number, number>();
  const done = new Map<string, number>(); // "nodeId:slot" -> operand byte
  const visiting = new Set<number>();
  let regs = 0;
  let sensorCount = 0;
  let overflow = "";

  /** Constants are pooled and deduped: the same 0.5 from ten widgets costs four bytes once. */
  function constant(v: Vec): number {
    const key = v.join(",");
    let at = constKeys.get(key);
    if (at === undefined) {
      at = consts.length / 4;
      if (at >= MAX_CONSTS) {
        overflow ||= `too many constants (max ${MAX_CONSTS}) - simplify the graph`;
        return CONST_FLAG;
      }
      consts.push(v[0], v[1], v[2], v[3]);
      constKeys.set(key, at);
    }
    return CONST_FLAG | at;
  }

  const scalar = (n: number): number => constant([n, n, n, 1]);

  function emit(op: number, src: number[], aux = 0, aux2 = 0): number {
    const dst = regs++;
    if (dst >= MAX_REGISTERS) {
      overflow ||= `too many nodes (max ${MAX_REGISTERS} instructions) - simplify the graph`;
      return 0;
    }
    code.push(op, dst, src[0] ?? 0, src[1] ?? 0, src[2] ?? 0, src[3] ?? 0, aux, aux2);
    return dst;
  }

  function fromFallback(f: Fallback | undefined, p: Props): number {
    if (!f) return scalar(0);
    if ("value" in f) return scalar(f.value);
    if ("uv" in f) return emit(OP.UV, []);
    return scalar(num(p[f.prop]));
  }

  /** The asset slot for an Image node, converting and caching its pixels on first use. */
  function assetFor(node: NodeLike): number {
    const known = assetOf.get(node.id);
    if (known !== undefined) return known;
    const img = images.get(node.id);
    // No upload: still a valid asset index, just a 1x1 transparent one. Keeps the VM free
    // of a "missing texture" branch, and the node renders clear exactly like the preview.
    const packed = img ? (img.packed ??= packImage(img)) : { w: 1, h: 1, format: ASSET.RGBA8888, data: new Uint8Array(4) };
    const at = assets.length;
    assets.push(packed);
    assetOf.set(node.id, at);
    return at;
  }

  /** Emits the instruction producing `slot` of `node`, and returns its operand byte. */
  function visit(node: NodeLike, slot: number): number {
    const key = `${node.id}:${slot}`;
    const memo = done.get(key);
    if (memo !== undefined) return memo;
    const def = NODES[node.type];
    // Unknown type - a graph saved by a newer build - reads as opaque black rather than
    // failing the whole compile.
    if (!def) return scalar(0);
    if (visiting.has(node.id)) return scalar(0);  // belt and braces; the loop below cuts cycles
    if (def.konst) return constant(def.konst(node.properties));

    const spec = def.outs?.[slot];
    if (!spec) return scalar(0);

    visiting.add(node.id);
    const src: number[] = [];
    (def.in ?? []).forEach((_name, i) => {
      const link = node.inputs?.[i]?.link;
      const l = link == null ? null : graph.links[link];
      const from = l ? byId.get(l.origin_id) : undefined;
      // A wire that closes a loop (litegraph will happily let you draw one) is treated as
      // if it were not there: the input falls back to its widget, same as an empty socket.
      const cyclic = from !== undefined && visiting.has(from.id);
      src.push(
        from && !cyclic ? visit(from, l!.origin_slot) : fromFallback(def.fallback?.[i], node.properties),
      );
    });
    for (const name of def.args ?? []) src.push(scalar(num(node.properties[name])));
    visiting.delete(node.id);

    const aux = def.asset ? assetFor(node) : (spec.aux?.(node.properties) ?? 0);
    const reg = emit(spec.op, src, aux, spec.aux2?.(node.properties) ?? 0);
    if (spec.op === OP.SENSOR) sensorCount = Math.max(sensorCount, aux + 1);
    done.set(key, reg);
    return reg;
  }

  visit(out, 0);
  if (overflow) return { ok: false, reason: overflow };

  return {
    ok: true,
    program: {
      code: Uint8Array.from(code),
      consts: Float32Array.from(consts),
      regCount: regs,
      sensorCount,
      assets,
      width: w,
      height: h,
    },
  };
}

/**
 * RGBA8888 when the image actually uses alpha, RGB565 otherwise. RGB565 halves the flash a
 * photo costs and is what most panels want anyway; it is not worth 4 bytes a pixel to store
 * an alpha channel that is 255 everywhere.
 */
export function packImage(img: ImageBuf): PackedAsset {
  const px = img.w * img.h;
  let opaque = true;
  for (let i = 3; i < px * 4 && opaque; i += 4) opaque = img.data[i] === 255;

  if (!opaque) return { w: img.w, h: img.h, format: ASSET.RGBA8888, data: Uint8Array.from(img.data) };

  const data = new Uint8Array(px * 2);
  for (let i = 0, o = 0; i < px; i++, o += 2) {
    const v = ((img.data[i * 4] >> 3) << 11) | ((img.data[i * 4 + 1] >> 2) << 5) | (img.data[i * 4 + 2] >> 3);
    data[o] = v & 0xff;
    data[o + 1] = v >> 8;
  }
  return { w: img.w, h: img.h, format: ASSET.RGB565, data };
}

// ---------------------------------------------------------------------------
// Interpret. Mirrored by ProtoShadeRuntime::sample() - keep the two in step, and let
// test/crosscheck.mjs tell you when they are not.
// ---------------------------------------------------------------------------

type MathFn = (a: number, b: number) => number;
const MATH: MathFn[] = [
  (a, b) => a + b,
  (a, b) => a - b,
  (a, b) => a * b,
  // Zero denominators come from live widgets, not from bugs: returning 0 keeps Infinity and
  // NaN out of the pixel buffer, where they show up as black holes that are hard to trace.
  (a, b) => (b === 0 ? 0 : a / b),
  (a, b) => (a < 0 ? 0 : Math.pow(a, b)),
  // Floored modulo, so mod(-0.25, 1) is 0.75 and a scrolling coordinate stays continuous
  // across zero. The % operator would give -0.25 and tear the pattern.
  (a, b) => (b === 0 ? 0 : a - Math.floor(a / b) * b),
  (a, b) => Math.min(a, b),
  (a, b) => Math.max(a, b),
  (a, b) => (a > b ? 1 : 0),
  (a, b) => (a < b ? 1 : 0),
  (a, b) => Math.atan2(a, b),
  (a) => Math.sin(a),
  (a) => Math.cos(a),
  (a) => Math.abs(a),
  (a) => Math.floor(a),
  (a) => Math.ceil(a),
  (a) => Math.round(a),
  (a) => a - Math.floor(a),
  (a) => (a < 0 ? 0 : Math.sqrt(a)),
  (a) => clamp01(a),
  (a) => {
    const x = clamp01(a);
    return x * x * (3 - 2 * x);
  },
];
if (MATH.length !== MATH_OPS.length) throw new Error("MATH table does not match MATH_OPS");

/** Squash a sensor reading into 0..1 by saturating, so an unbounded one never flatlines. */
const UNIT: ((x: number) => number)[] = [
  clamp01,
  (x) => clamp01(x * 0.5 + 0.5),
  (x) => (x <= 0 ? 0 : x / (1 + x)),
  (x) => 0.5 + (0.5 * x) / (1 + Math.abs(x)),
  // Degrees wrap rather than clamp: at 359 a head is one degree from 0, not at the far end.
  (x) => (((x % 360) + 360) % 360) / 360,
];
if (UNIT.length !== RANGES.length) throw new Error("UNIT table does not match RANGES");

/** Reusable machine state, so a frame does not allocate once per pixel. */
export class Runner {
  private readonly regs: Float32Array;
  constructor(private readonly p: Program) {
    this.regs = new Float32Array(Math.max(1, p.regCount) * 4);
  }

  /** Colour of one pixel, 0..1 per channel, written into `out`. */
  run(env: Env, out: Vec): void {
    const { code, consts, assets } = this.p;
    const regs = this.regs;
    const n = code.length / INSTR_SIZE;
    // Operand -> the four floats it names, in whichever array holds them.
    const at = (o: number): number => ((o & CONST_FLAG) !== 0 ? (o & 0x7f) * 4 : o * 4);
    const of = (o: number): Float32Array => ((o & CONST_FLAG) !== 0 ? consts : regs);

    let d = 0;
    for (let i = 0; i < n; i++) {
      const b = i * INSTR_SIZE;
      const op = code[b];
      d = code[b + 1] * 4;
      const a0 = of(code[b + 2]);
      const i0 = at(code[b + 2]);
      const aux = code[b + 6];
      const aux2 = code[b + 7];

      switch (op) {
        case OP.UV:
          regs[d] = env.u;
          regs[d + 1] = env.v;
          regs[d + 2] = 0;
          regs[d + 3] = 1;
          break;
        case OP.CENTERED:
          // Aspect-corrected, so a circle on a 64x32 panel stays round.
          regs[d] = (env.u * 2 - 1) * (env.w / Math.max(env.h, 1));
          regs[d + 1] = env.v * 2 - 1;
          regs[d + 2] = 0;
          regs[d + 3] = 1;
          break;
        case OP.PIXEL:
          regs[d] = env.x;
          regs[d + 1] = env.y;
          regs[d + 2] = 0;
          regs[d + 3] = 1;
          break;
        case OP.TIME:
          broadcast(regs, d, env.t * a0[i0]);
          break;
        case OP.SENSOR: {
          const live = env.sensors?.[aux];
          const raw = live === undefined ? a0[i0] : live;
          broadcast(regs, d, (aux2 & 1) !== 0 ? UNIT[(aux2 >> 1) % UNIT.length](raw) : raw);
          break;
        }
        case OP.MATH: {
          const b1 = of(code[b + 3]);
          const j = at(code[b + 3]);
          const f = MATH[aux % MATH.length];
          regs[d] = f(a0[i0], b1[j]);
          regs[d + 1] = f(a0[i0 + 1], b1[j + 1]);
          regs[d + 2] = f(a0[i0 + 2], b1[j + 2]);
          // Alpha rides through from A: scaling a colour must not change its coverage, and
          // a scalar B broadcasts to alpha 1, which add and divide would wreck.
          regs[d + 3] = a0[i0 + 3];
          break;
        }
        case OP.MIX: {
          const A = of(code[b + 3]);
          const j = at(code[b + 3]);
          const B = of(code[b + 4]);
          const k = at(code[b + 4]);
          const f = a0[i0];
          for (let c = 0; c < 4; c++) regs[d + c] = A[j + c] + (B[k + c] - A[j + c]) * f;
          break;
        }
        case OP.OVER: {
          const F = of(code[b + 3]);
          const j = at(code[b + 3]);
          const B = of(code[b + 4]);
          const k = at(code[b + 4]);
          const af = clamp01(F[j + 3]) * clamp01(a0[i0]);
          const ab = clamp01(B[k + 3]);
          const a = af + ab * (1 - af);
          if (a === 0) {
            // Fully transparent: the colour is meaningless, so keep it black instead of 0/0.
            regs[d] = regs[d + 1] = regs[d + 2] = regs[d + 3] = 0;
          } else {
            // Straight (un-premultiplied) alpha in and out, so two of these compose.
            for (let c = 0; c < 3; c++) regs[d + c] = (F[j + c] * af + B[k + c] * ab * (1 - af)) / a;
            regs[d + 3] = a;
          }
          break;
        }
        case OP.SWIZZLE:
          broadcast(regs, d, a0[i0 + (aux & 3)]);
          break;
        case OP.COMBINE:
          for (let c = 0; c < 4; c++) regs[d + c] = of(code[b + 2 + c])[at(code[b + 2 + c])];
          break;
        case OP.HSV:
          hsv(
            regs,
            d,
            a0[i0],
            of(code[b + 3])[at(code[b + 3])],
            of(code[b + 4])[at(code[b + 4])],
            of(code[b + 5])[at(code[b + 5])],
          );
          break;
        case OP.TEX:
          texture(regs, d, assets[aux], a0[i0], a0[i0 + 1], aux2);
          break;
        case OP.OUTPUT: {
          // An LED is on or off; there is nothing behind it to show through, so alpha
          // composites against black here - the one place transparency gets resolved.
          const k = of(code[b + 3])[at(code[b + 3])] * clamp01(a0[i0 + 3]);
          regs[d] = clamp01(a0[i0] * k);
          regs[d + 1] = clamp01(a0[i0 + 1] * k);
          regs[d + 2] = clamp01(a0[i0 + 2] * k);
          regs[d + 3] = 1;
          break;
        }
        default:
          broadcast(regs, d, 0);
      }
    }
    out[0] = regs[d];
    out[1] = regs[d + 1];
    out[2] = regs[d + 2];
    out[3] = regs[d + 3];
  }
}

function broadcast(r: Float32Array, d: number, x: number): void {
  r[d] = r[d + 1] = r[d + 2] = x;
  r[d + 3] = 1;
}

function hsv(r: Float32Array, d: number, h: number, s: number, v: number, a: number): void {
  const hh = (h - Math.floor(h)) * 6;
  const c = clamp01(v) * clamp01(s);
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = clamp01(v) - c;
  const i = Math.floor(hh) % 6;
  const t = i === 0 ? [c, x, 0] : i === 1 ? [x, c, 0] : i === 2 ? [0, c, x] : i === 3 ? [0, x, c] : i === 4 ? [x, 0, c] : [c, 0, x];
  r[d] = t[0] + m;
  r[d + 1] = t[1] + m;
  r[d + 2] = t[2] + m;
  r[d + 3] = a;
}

/** Reads the packed asset bytes - the same ones the .bin carries and the ESP32 samples. */
function texel(a: PackedAsset, xi: number, yi: number, wrap: number, out: Vec): void {
  const fold = (t: number, n: number): number => (wrap !== 0 ? Math.min(Math.max(t, 0), n - 1) : ((t % n) + n) % n);
  const i = fold(yi, a.h) * a.w + fold(xi, a.w);
  // clip keeps the edge COLOUR but drops the alpha, so a linear fetch at the boundary fades
  // out instead of fading to black and leaving a dark fringe round the sprite.
  const clipped = wrap === 2 && (xi < 0 || yi < 0 || xi >= a.w || yi >= a.h);
  if (a.format === ASSET.RGBA8888) {
    out[0] = a.data[i * 4] / 255;
    out[1] = a.data[i * 4 + 1] / 255;
    out[2] = a.data[i * 4 + 2] / 255;
    out[3] = clipped ? 0 : a.data[i * 4 + 3] / 255;
  } else if (a.format === ASSET.A8) {
    out[0] = out[1] = out[2] = 1;
    out[3] = clipped ? 0 : a.data[i] / 255;
  } else {
    const v = a.data[i * 2] | (a.data[i * 2 + 1] << 8);
    out[0] = ((v >> 11) & 31) / 31;
    out[1] = ((v >> 5) & 63) / 63;
    out[2] = (v & 31) / 31;
    out[3] = clipped ? 0 : 1;
  }
}

const t0: Vec = [0, 0, 0, 0];
const t1: Vec = [0, 0, 0, 0];
const t2: Vec = [0, 0, 0, 0];
const t3: Vec = [0, 0, 0, 0];

function texture(r: Float32Array, d: number, a: PackedAsset | undefined, u: number, v: number, flags: number): void {
  if (!a) {
    r[d] = r[d + 1] = r[d + 2] = r[d + 3] = 0;
    return;
  }
  const wrap = flags & 3;
  if ((flags & 4) === 0) {
    texel(a, Math.floor(u * a.w), Math.floor(v * a.h), wrap, t0);
  } else {
    const x = u * a.w - 0.5;
    const y = v * a.h - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    texel(a, x0, y0, wrap, t0);
    texel(a, x0 + 1, y0, wrap, t1);
    texel(a, x0, y0 + 1, wrap, t2);
    texel(a, x0 + 1, y0 + 1, wrap, t3);
    for (let c = 0; c < 4; c++) {
      const top = t0[c] + (t1[c] - t0[c]) * fx;
      t0[c] = top + (t2[c] + (t3[c] - t2[c]) * fx - top) * fy;
    }
  }
  if ((flags & 8) !== 0) {
    broadcast(r, d, t0[3]);
    return;
  }
  r[d] = t0[0];
  r[d + 1] = t0[1];
  r[d + 2] = t0[2];
  r[d + 3] = t0[3];
}
