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
  BLEND_MODES,
  CONST_FLAG,
  INSTR_SIZE,
  MATH_OPS,
  MAX_CONSTS,
  MAX_PARTICLES,
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
  // A baked strip is megabytes, and a deleted node would otherwise keep one alive for the
  // rest of the session. This is the one place that knows which nodes still exist.
  if (bakeCache.size > 0) {
    const live = new Set(graph._nodes.map((n) => n.id));
    for (const id of bakeCache.keys()) if (!live.has(id)) bakeCache.delete(id);
  }
  return compileFrom(graph, images, w, h, out, 0);
}

/**
 * The program that computes `slot` of `root`, ending with that node's own instruction.
 *
 * With the LED Output as the root that is the whole shader, which is what compile() asks
 * for. With any other node it is the branch feeding it, which is what a Bake node asks for
 * so it can render that branch here instead of shipping it - the sub-program is only ever
 * run by Runner, never packed, so it does not need to end in an OUTPUT.
 */
function compileFrom(
  graph: GraphLike,
  images: Map<number, ImageBuf>,
  w: number,
  h: number,
  root: NodeLike,
  rootSlot: number,
): CompileResult {
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
  let particleBudget = 0;
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

  /**
   * A run of constants the VM reads by walking forward from one operand. Appended in order
   * and never deduplicated - pooling would happily put an equal quad somewhere else and
   * break the only thing the block guarantees, which is that the next one is next.
   */
  function constBlock(quads: Vec[]): number {
    const at = consts.length / 4;
    if (at + quads.length > MAX_CONSTS) {
      overflow ||= `too many constants (max ${MAX_CONSTS}) - simplify the graph`;
      return CONST_FLAG;
    }
    for (const v of quads) consts.push(v[0], v[1], v[2], v[3]);
    return CONST_FLAG | at;
  }

  // Whether each register holds a value that is the same for every pixel in a frame. Same
  // rule the device applies when it hoists the uniform instructions out of the pixel loop,
  // mirrored here for the one thing the compiler has to refuse: a particle system whose
  // clock changes from pixel to pixel, which the head could not honour.
  const uniformReg: boolean[] = [];
  const isUniform = (operand: number): boolean =>
    (operand & CONST_FLAG) !== 0 || uniformReg[operand] === true;

  function emit(op: number, src: number[], aux = 0, aux2 = 0): number {
    const dst = regs++;
    if (dst >= MAX_REGISTERS) {
      overflow ||= `too many nodes (max ${MAX_REGISTERS} instructions) - simplify the graph`;
      return 0;
    }
    code.push(op, dst, src[0] ?? 0, src[1] ?? 0, src[2] ?? 0, src[3] ?? 0, aux, aux2);
    uniformReg[dst] =
      op !== OP.UV && op !== OP.CENTERED && op !== OP.PIXEL && src.every((o) => isUniform(o));
    return dst;
  }

  function fromFallback(f: Fallback | undefined, p: Props): number {
    if (!f) return scalar(0);
    if ("value" in f) return scalar(f.value);
    if ("emit" in f) {
      const arg = typeof f.arg === "number" ? f.arg : f.arg === undefined ? undefined : num(p[f.arg]);
      return emit(f.emit, arg === undefined ? [] : [scalar(arg)]);
    }
    return scalar(num(p[f.prop]));
  }

  /** The asset slot for an Image node, converting and caching its pixels on first use. */
  function assetFor(node: NodeLike): number {
    const known = assetOf.get(node.id);
    if (known !== undefined) return known;
    const img = images.get(node.id);
    // No upload: still a valid asset index, just a 1x1 transparent one. Keeps the VM free
    // of a "missing texture" branch, and the node renders clear exactly like the preview.
    return use(node.id, img ? (img.packed ??= packImage(img)) : EMPTY_ASSET);
  }

  /** Puts a packed asset in the table and remembers which node it came from. */
  function use(nodeId: number, packed: PackedAsset): number {
    const at = assets.length;
    assets.push(packed);
    assetOf.set(nodeId, at);
    return at;
  }

  /**
   * A Bake node: render the branch above it here, pack the frames as a strip, and leave the
   * head an ANIM lookup into it. The driver - the clock, or a sensor - is NOT baked: it is
   * still read live on every device frame, and everything else in the graph is untouched.
   * What the bake freezes is the branch's shape, which is the expensive part.
   */
  function bakeFor(node: NodeLike, slot: number): number {
    const p = node.properties;
    const link = node.inputs?.[0]?.link;
    const l = link == null ? null : graph.links[link];
    const from = l ? byId.get(l.origin_id) : undefined;
    if (!from || visiting.has(from.id)) return scalar(0); // nothing wired in: nothing to bake

    const frames = Math.max(2, Math.min(256, Math.round(num(p.frames)) || 2));
    if (h * frames > MAX_STRIP_ROWS) {
      overflow ||= `baked strip is ${h * frames} rows - drop the frame count or the resolution`;
      return scalar(0);
    }
    const sub = compileFrom(graph, images, w, h, from, l!.origin_slot);
    if (!sub.ok) {
      overflow ||= sub.reason;
      return scalar(0);
    }

    const byTime = p.driver !== "sensor";
    const range = Math.max(0, RANGES.indexOf(String(p.range) as never));
    const slotIndex = Math.max(0, Math.min(255, Math.round(num(p.slot))));
    const seconds = num(p.seconds) > 0 ? num(p.seconds) : 1;
    const settings = `${byTime}|${frames}|${seconds}|${slotIndex}|${range}|${w}|${h}`;

    let at = assetOf.get(node.id);
    if (at === undefined) {
      const key = `${settings}|${subKey(sub.program)}`;
      // Rendering thousands of pixels per frame of the strip is not something to redo on
      // every editor frame, and the only thing that can change what comes out is the
      // sub-program plus these settings - so that pair is the cache key.
      let hit = bakeCache.get(node.id);
      if (!hit || hit.key !== key) {
        hit = { key, asset: bakeStrip(sub.program, { frames, w, h, byTime, seconds, range, slot: slotIndex }) };
        bakeCache.set(node.id, hit);
      }
      at = use(node.id, hit.asset);
    }

    const uv = emit(OP.UV, []);
    // Time in cycles of `seconds`, or the sensor reading squashed to 0..1 - the same unit
    // the strip was swept over, so frame k on the head is the frame k that was rendered.
    const phase = byTime
      ? emit(OP.TIME, [scalar(1 / seconds)])
      : emit(OP.SENSOR, [scalar(0)], slotIndex, (range << 1) | 1);
    if (!byTime) sensorCount = Math.max(sensorCount, slotIndex + 1);
    // clamp, nearest: the strip is the panel, sampled 1:1. loop only when time drives it.
    const flags = 1 | (p.crossfade ? 16 : 0) | (byTime ? 32 : 0) | (slot === 1 ? 8 : 0);
    return emit(OP.ANIM, [uv, phase], at, flags);
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
    if (def.bake) {
      visiting.add(node.id);
      const reg = bakeFor(node, slot);
      visiting.delete(node.id);
      done.set(key, reg);
      return reg;
    }

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
    if (def.argsBlock) {
      const quads = def.argsBlock(node.properties);
      // The particle budget is the PROGRAM's, not the node's: every emitter draws out of
      // the one table the device keeps per rendering thread. Clamping here rather than
      // letting the head refuse the .bin means the preview shows what will actually run.
      if (spec.op === OP.PARTICLES) {
        const want = Math.max(0, Math.round(quads[0][0]));
        const got = Math.min(want, MAX_PARTICLES - particleBudget);
        particleBudget += got;
        quads[0][0] = got;
        // The clock is read once per frame on the device, so it may not vary per pixel.
        if (!isUniform(src[1])) {
          overflow ||= "Particles: the Time input has to be the same for every pixel - it cannot come from Coordinates";
        }
      }
      src.push(constBlock(quads));
    }
    visiting.delete(node.id);

    const aux = def.asset ? assetFor(node) : (spec.aux?.(node.properties) ?? 0);
    const reg = emit(spec.op, src, aux, spec.aux2?.(node.properties) ?? 0);
    if (spec.op === OP.SENSOR) sensorCount = Math.max(sensorCount, aux + 1);
    done.set(key, reg);
    return reg;
  }

  visit(root, rootSlot);
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
  const frames = Math.max(1, img.frames || 1);
  let opaque = true;
  for (let i = 3; i < px * 4 && opaque; i += 4) opaque = img.data[i] === 255;

  if (!opaque) return { w: img.w, h: img.h, frames, format: ASSET.RGBA8888, data: Uint8Array.from(img.data) };

  const data = new Uint8Array(px * 2);
  for (let i = 0, o = 0; i < px; i++, o += 2) {
    const v = ((img.data[i * 4] >> 3) << 11) | ((img.data[i * 4 + 1] >> 2) << 5) | (img.data[i * 4 + 2] >> 3);
    data[o] = v & 0xff;
    data[o + 1] = v >> 8;
  }
  return { w: img.w, h: img.h, frames, format: ASSET.RGB565, data };
}

// ---------------------------------------------------------------------------
// Bake. Spend the browser's CPU and some flash so the head does not have to compute the
// same picture over and over. What comes out is a strip of frames and an ANIM that indexes
// it live - a partial bake, not a pre-rendered face: the driver, and every other branch of
// the graph, still run per frame on the device.
// ---------------------------------------------------------------------------

/** An uploadless Image node. One object, not one per compile, so a bake key stays stable. */
const EMPTY_ASSET: PackedAsset = { w: 1, h: 1, frames: 1, format: ASSET.RGBA8888, data: new Uint8Array(4) };

/** A strip's height is a uint16 in the container. */
const MAX_STRIP_ROWS = 65535;

const bakeCache = new Map<number, { key: string; asset: PackedAsset }>();

// Packed assets are cached on the ImageBuf, so the same upload is the same object every
// compile: identity is a cheap stand-in for hashing megabytes of pixels once a frame.
const assetIds = new WeakMap<PackedAsset, number>();
let nextAssetId = 0;
function idOf(a: PackedAsset): number {
  let id = assetIds.get(a);
  if (id === undefined) assetIds.set(a, (id = ++nextAssetId));
  return id;
}

/** Everything about a sub-program that could change what baking it produces. */
function subKey(p: Program): string {
  return `${p.code.join(",")}/${Array.from(p.consts).join(",")}/${p.assets.map(idOf).join(",")}`;
}

/**
 * Inverse of the UNIT squash below: the raw reading whose Unit output is `u`. Sweeping the
 * raw value through here and indexing the strip by Unit means frame k on the head is
 * exactly the frame k that was rendered, for every range including the unbounded ones.
 */
export function sweepRaw(range: number, u: number): number {
  const c = Math.min(Math.max(u, 0), 0.98); // the saturating ranges only reach 1 at infinity
  switch (range) {
    case 1:
      return c * 2 - 1;
    case 2:
      return c / (1 - c);
    case 3: {
      const y = c * 2 - 1;
      return y / (1 - Math.abs(y));
    }
    case 4:
      return u * 360;
    default:
      return u;
  }
}

export interface BakeOptions {
  frames: number;
  w: number;
  h: number;
  /** true: sweep the clock over `seconds`. false: sweep sensor `slot` across its range. */
  byTime: boolean;
  seconds: number;
  range: number;
  slot: number;
}

/**
 * Renders `program` once per frame into one tall strip. Alpha survives - the sub-program
 * ends at the baked branch, not at an LED Output, so a baked sprite still composites.
 */
export function bakeStrip(program: Program, o: BakeOptions): PackedAsset {
  const runner = new Runner(program);
  const env: Env = { x: 0, y: 0, u: 0, v: 0, w: o.w, h: o.h, t: 0, frame: 0 };
  const colour: Vec = [0, 0, 0, 1];
  const data = new Uint8ClampedArray(o.w * o.h * o.frames * 4);
  const sensors: number[] = [];

  for (let f = 0, p = 0; f < o.frames; f++) {
    if (o.byTime) {
      // The START of the frame's slice, not its middle: with crossfade on, that is what the
      // lerp between frame f and f+1 assumes, and it makes the loop close exactly at
      // `seconds`. Without crossfade it is half a frame early, which no eye will find.
      env.t = (f * o.seconds) / o.frames;
      env.frame = f;
      env.sensors = undefined;
    } else {
      // Hold mode maps 0..1 across the strip with both ends included, so the last frame is
      // the one the sensor shows at full scale.
      sensors[o.slot] = sweepRaw(o.range, f / (o.frames - 1));
      env.sensors = sensors;
    }
    for (let y = 0; y < o.h; y++) {
      for (let x = 0; x < o.w; x++, p += 4) {
        env.x = x;
        env.y = y;
        env.u = (x + 0.5) / o.w;
        env.v = (y + 0.5) / o.h;
        runner.run(env, colour);
        data[p] = Math.round(colour[0] * 255);
        data[p + 1] = Math.round(colour[1] * 255);
        data[p + 2] = Math.round(colour[2] * 255);
        data[p + 3] = Math.round(clamp01(colour[3]) * 255);
      }
    }
  }
  return packImage({ w: o.w, h: o.h * o.frames, frames: o.frames, data });
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

/** Mirrors blendOp() in the C++ VM. `cb` is the background, `cs` the foreground. */
const BLEND: MathFn[] = [
  (_cb, cs) => cs,
  (cb, cs) => cb * cs,
  (cb, cs) => cb + cs - cb * cs,
  (cb, cs) => Math.min(1, cb + cs),
  (cb, cs) => Math.max(cb, cs),
  (cb, cs) => Math.min(cb, cs),
  (cb, cs) => Math.abs(cb - cs),
];
if (BLEND.length !== BLEND_MODES.length) throw new Error("BLEND table does not match BLEND_MODES");

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
  /** Per Particles instruction: the particles, and the clock they were worked out for. */
  private readonly swarms = new Map<number, { t: number; list: Particle[] }>();

  constructor(private readonly p: Program) {
    this.regs = new Float32Array(Math.max(1, p.regCount) * 4);
  }

  /**
   * The particles of instruction `i` at clock `t`, worked out again only when the clock has
   * moved. On the device this is a per-frame pass; here the clock IS the frame, and keying
   * on it keeps a sensor-driven emitter correct without the interpreter knowing what a
   * frame is.
   */
  private readyParticles(i: number, n: number, t: number, block: number, frames: number): Particle[] {
    let swarm = this.swarms.get(i);
    if (!swarm) {
      swarm = { t: NaN, list: [] };
      this.swarms.set(i, swarm);
    }
    while (swarm.list.length < n) {
      swarm.list.push({ x: 0, y: 0, invScale: 0, cosR: 1, sinR: 0, alpha: 0, frame: 0 });
    }
    if (swarm.t !== t) {
      prepareParticles(swarm.list, n, t, this.p.consts, block, frames);
      swarm.t = t;
    }
    return swarm.list;
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
            //
            // The blend mode applies only where both layers cover - the (1 - ab) term. Over
            // the part of the foreground hanging off the background there is no second
            // colour to combine with, so it keeps its own.
            const blend = BLEND[aux % BLEND.length];
            for (let c = 0; c < 3; c++) {
              const blended = (1 - ab) * F[j + c] + ab * blend(B[k + c], F[j + c]);
              regs[d + c] = (blended * af + B[k + c] * ab * (1 - af)) / a;
            }
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
        case OP.ANIM:
          animation(regs, d, assets[aux], a0[i0], a0[i0 + 1], of(code[b + 3])[at(code[b + 3])], aux2);
          break;
        case OP.PARTICLES: {
          regs[d] = regs[d + 1] = regs[d + 2] = regs[d + 3] = 0;
          const asset = assets[aux];
          const block = (code[b + 4] & 0x7f) * 4;
          const n = Math.min(MAX_PARTICLES, Math.max(0, Math.floor(consts[block]) || 0));
          if (!asset || n === 0) break;
          // Prepared per value of the clock, not per pixel - the device works the same way,
          // once per frame, and a rotated sprite would otherwise cost four sines a pixel.
          const list = this.readyParticles(i, n, of(code[b + 3])[at(code[b + 3])], block, Math.max(1, asset.frames));
          const f = Math.fround;
          for (let k = 0; k < n; k++) {
            const p = list[k];
            if (!(p.alpha > 0)) continue; // faded out, or scaled to nothing
            const dx = f(a0[i0] - p.x);
            const dy = f(a0[i0 + 1] - p.y);
            sampleFrame(
              asset,
              p.frame,
              f(f(f(f(dx * p.cosR) + f(dy * p.sinR)) * p.invScale) + 0.5),
              f(f(f(f(dy * p.cosR) - f(dx * p.sinR)) * p.invScale) + 0.5),
              (aux2 & 4) | 2, // clip: a particle is its sprite and nothing else
              t4,
            );
            overInto(regs, d, t4, p.alpha);
          }
          break;
        }
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

/** Reads the packed asset bytes - the same ones the .bin carries and the ESP32 samples.
    Coordinates are frame-local: yi runs 0..rows-1, and `base` is the frame's first row. */
function texel(a: PackedAsset, xi: number, yi: number, base: number, rows: number, wrap: number, out: Vec): void {
  const fold = (t: number, n: number): number => (wrap !== 0 ? Math.min(Math.max(t, 0), n - 1) : ((t % n) + n) % n);
  const i = (base + fold(yi, rows)) * a.w + fold(xi, a.w);
  // clip keeps the edge COLOUR but drops the alpha, so a linear fetch at the boundary fades
  // out instead of fading to black and leaving a dark fringe round the sprite.
  const clipped = wrap === 2 && (xi < 0 || yi < 0 || xi >= a.w || yi >= rows);
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

// Scratch quads, reused so a frame does not allocate once per texel fetch.
const t0: Vec = [0, 0, 0, 0];
const t1: Vec = [0, 0, 0, 0];
const t2: Vec = [0, 0, 0, 0];
const t3: Vec = [0, 0, 0, 0];
const t4: Vec = [0, 0, 0, 0];
const tex: Vec = [0, 0, 0, 0];

/** One frame of one asset at (u, v) in 0..1 of that frame, into `out`. Mirrors
    ProtoShadeRuntime::sampleFrame - every fetch in the VM comes through here. */
function sampleFrame(a: PackedAsset, frame: number, u: number, v: number, flags: number, out: Vec): void {
  const f = Math.fround;
  const frames = Math.max(1, a.frames);
  const rows = (a.h / frames) | 0;
  const base = Math.min(Math.max(frame, 0), frames - 1) * rows;
  const wrap = flags & 3;
  // fround, not the plain product: the device multiplies in single precision, and when the
  // exact product sits a hair under a texel boundary the two rounding modes land on
  // different texels. That is a whole wrong pixel, not a rounding difference.
  if ((flags & 4) === 0) {
    texel(a, Math.floor(f(u * a.w)), Math.floor(f(v * rows)), base, rows, wrap, out);
    return;
  }
  const x = f(f(u * a.w) - 0.5);
  const y = f(f(v * rows) - 0.5);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = f(x - x0);
  const fy = f(y - y0);
  texel(a, x0, y0, base, rows, wrap, t0);
  texel(a, x0 + 1, y0, base, rows, wrap, t1);
  texel(a, x0, y0 + 1, base, rows, wrap, t2);
  texel(a, x0 + 1, y0 + 1, base, rows, wrap, t3);
  for (let c = 0; c < 4; c++) {
    const top = t0[c] + (t1[c] - t0[c]) * fx;
    out[c] = top + (t2[c] + (t3[c] - t2[c]) * fx - top) * fy;
  }
}

/** Writes an RGBA quad to a register, or just its alpha when the alpha-out flag is set. */
function writeTexel(r: Float32Array, d: number, rgba: Vec, flags: number): void {
  if ((flags & 8) !== 0) {
    broadcast(r, d, rgba[3]);
    return;
  }
  r[d] = rgba[0];
  r[d + 1] = rgba[1];
  r[d + 2] = rgba[2];
  r[d + 3] = rgba[3];
}

function texture(r: Float32Array, d: number, a: PackedAsset | undefined, u: number, v: number, flags: number): void {
  if (!a) {
    r[d] = r[d + 1] = r[d + 2] = r[d + 3] = 0;
    return;
  }
  sampleFrame(a, 0, u, v, flags, tex);
  writeTexel(r, d, tex, flags);
}

/** Frame `phase` of a strip. flags bit 4 crossfades between neighbours, bit 5 loops. */
function animation(r: Float32Array, d: number, a: PackedAsset | undefined, u: number, v: number, phase: number, flags: number): void {
  if (!a) {
    r[d] = r[d + 1] = r[d + 2] = r[d + 3] = 0;
    return;
  }
  const frames = Math.max(1, a.frames);
  // loop: phase counts whole cycles. hold: phase is 0..1 across the strip, clamped.
  // Either way the index is floored onto a frame that exists - a phase between two frames
  // picks one of them, it does not conjure an image that was never drawn. Crossfade (bit 4)
  // is how you ask for that dissolve on purpose.
  const f = Math.fround;
  const t = (flags & 32) !== 0 ? f(f(phase - Math.floor(phase)) * frames) : f(clamp01(phase) * (frames - 1));
  const f0 = Math.min(Math.floor(t), frames - 1);
  sampleFrame(a, f0, u, v, flags, tex);
  if ((flags & 16) !== 0) {
    const f1 = (flags & 32) !== 0 ? (f0 + 1) % frames : Math.min(f0 + 1, frames - 1);
    sampleFrame(a, f1, u, v, flags, t4);
    const k = f(t - f0);
    for (let c = 0; c < 4; c++) tex[c] += (t4[c] - tex[c]) * k;
  }
  writeTexel(r, d, tex, flags);
}

/**
 * One particle, ready for the pixel loop. Mirrors protoshade::Particle.
 *
 * The device works these out once per frame, right after the instructions it hoists out of
 * the pixel loop, because none of it varies across a frame and four sines per particle per
 * pixel would melt the ESP32. Doing the same here is not an optimisation for the browser's
 * sake - it is what makes the preview run the same arithmetic the head does.
 */
interface Particle {
  x: number;
  y: number;
  invScale: number;
  cosR: number;
  sinR: number;
  alpha: number;
  frame: number;
}

const DEG_TO_RAD = 0.017453292;

/**
 * Sine and cosine to the same bits as the C++ VM: the identical range reduction and the
 * identical polynomial, each step rounded to a float with Math.fround. Math.sin would be a
 * double's answer, and one ulp of difference in a rotation puts a sprite's edge on the
 * other side of a texel - a wrong pixel, not a rounding difference.
 */
function sinCos(x: number, out: { s: number; c: number }): void {
  const f = Math.fround;
  if (!(x > -1e6 && x < 1e6)) x = 0; // sane, finite, and small enough for the |0 below
  const k = Math.floor(f(f(x * 0.63661977) + 0.5));
  const r = f(x - f(k * 1.5707964));
  const r2 = f(r * r);
  const sr = f(r * f(1 + f(r2 * f(-0.16666667 + f(r2 * f(0.008333333 + f(r2 * -0.0001984127)))))));
  const cr = f(1 + f(r2 * f(-0.5 + f(r2 * f(0.041666668 + f(r2 * -0.0013888889))))));
  const q = k & 3;
  switch (q < 0 ? q + 4 : q) {
    case 1:
      out.s = cr;
      out.c = -sr;
      break;
    case 2:
      out.s = -sr;
      out.c = -cr;
      break;
    case 3:
      out.s = -cr;
      out.c = sr;
      break;
    default:
      out.s = sr;
      out.c = cr;
  }
}

const trig = { s: 0, c: 0 };

/**
 * Every particle of one emitter, for one value of the clock. The parameter block is five
 * constants - see prepareParticles() in the C++ VM, which reads them in this same order.
 */
function prepareParticles(out: Particle[], n: number, t: number, p: Float32Array, at: number, frames: number): void {
  const f = Math.fround;
  const life = p[at + 1] > 0 ? p[at + 1] : 1;
  const invLife = f(1 / life);
  const fade = clamp01(p[at + 2]);
  const seed = Math.min(65535, Math.max(0, p[at + 3])) >>> 0;
  const direction = p[at + 4];
  const spread = p[at + 5];
  const speed = p[at + 6];
  const speedSpread = p[at + 7];
  const accel = p[at + 8];
  const gx = p[at + 9];
  const gy = p[at + 10];
  const size = p[at + 12];
  const sizeSpread = p[at + 13];
  const sizeRate = p[at + 14];
  const sizeAccel = p[at + 15];
  const rotation = p[at + 16];
  const rotSpread = p[at + 17];
  const rotRate = p[at + 18];
  const rotAccel = p[at + 19];

  for (let i = 0; i < n; i++) {
    // The offset is not decoration: the finaliser maps 0 to 0, so particle 0 of seed 0
    // would come out with every random exactly zero - frozen at the emitter, in the one
    // configuration somebody reaching for defaults will hit first.
    const h0 = hashU32((Math.imul(i, 0x9e3779b9) + seed + 0x2545f491) >>> 0);
    const h1 = hashU32(h0);
    const h2 = hashU32(h1);
    const h3 = hashU32(h2);
    const h4 = hashU32(h3);
    const h5 = hashU32(h4);

    const phase = f(f(t * invLife) + unitOf(h0));
    const age = f(phase - Math.floor(phase)); // staggered, so the swarm does not restart as one
    const lived = f(age * life);

    // Spread is the full cone, so 360 really is all around and 0 is a straight line.
    const dir = f(f(direction + f(f(f(f(unitOf(h1) * 2) - 1) * spread) * 0.5)) * DEG_TO_RAD);
    const sp = f(speed + f(f(f(unitOf(h2) * 2) - 1) * speedSpread));
    sinCos(dir, trig);
    // 0 degrees is up the panel, degrees clockwise - a compass bearing, not school trig.
    const dx = trig.s;
    const dy = f(-trig.c);
    const ax = f(f(dx * accel) + gx);
    const ay = f(f(dy * accel) + gy);
    const particle = out[i];
    particle.x = f(f(f(dx * sp) * lived) + f(f(0.5 * ax) * f(lived * lived)));
    particle.y = f(f(f(dy * sp) * lived) + f(f(0.5 * ay) * f(lived * lived)));

    const scale = f(
      f(f(size + f(f(f(unitOf(h3) * 2) - 1) * sizeSpread)) + f(sizeRate * lived)) +
        f(f(0.5 * sizeAccel) * f(lived * lived)),
    );
    const rot = f(
      f(
        f(rotation + f(f(f(f(unitOf(h4) * 2) - 1) * rotSpread) * 0.5)) +
          f(rotRate * lived) +
          f(f(0.5 * rotAccel) * f(lived * lived)),
      ) * DEG_TO_RAD,
    );
    sinCos(rot, trig);
    particle.sinR = trig.s;
    particle.cosR = trig.c;
    // Scaled to nothing is skipped rather than divided by: alpha 0 is how the pixel loop is
    // told there is nothing here, and it already has that branch for fade.
    particle.invScale = scale > 0 ? f(1 / scale) : 0;
    particle.alpha = scale > 0 ? f(1 - f(fade * age)) : 0;
    particle.frame = Math.floor(unitOf(h5) * frames);
  }
}

/** Murmur3's finaliser. Must agree with hashU32 in the C++ VM bit for bit. */
function hashU32(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** 0..1 from the top sixteen bits - exact in a float as well as a double. */
const unitOf = (h: number): number => (h >>> 16) / 65536;

/** Straight-alpha source-over into a register, in place. */
function overInto(r: Float32Array, d: number, fg: Vec, fa: number): void {
  const af = clamp01(fg[3]) * clamp01(fa);
  const ab = clamp01(r[d + 3]);
  const alpha = af + ab * (1 - af);
  if (alpha === 0) {
    r[d] = r[d + 1] = r[d + 2] = r[d + 3] = 0;
    return;
  }
  for (let c = 0; c < 3; c++) r[d + c] = (fg[c] * af + r[d + c] * ab * (1 - af)) / alpha;
  r[d + 3] = alpha;
}
