// Turns a node graph into a per-pixel function.
//
// It reads the live LGraph object rather than graph.serialize(): same fields, no deep
// clone, so the preview loop can just recompile every frame and never has to track
// dirty state. ponytail: that is O(nodes) per frame, invisible for the dozens of nodes a
// panel shader needs. If a graph ever gets big enough to show up in the frame time,
// recompile from litegraph's onAfterChange / onConnectionChange instead.
//
// The shape below is also all a hand-written literal needs, which is how
// test/graph-eval.test.mjs compiles graphs without a browser.

import { NODES, OUTPUT_TYPE, type Env, type Props, type Vec } from "./nodes.js";

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

interface Step {
  id: number;
  props: Props;
  ev: (typeof NODES)[string]["eval"];
  /** Per input: [step index, output slot], or null when nothing is wired in. */
  src: ([number, number] | null)[];
}

export interface Compiled {
  /** Colour of one pixel, 0..1 per channel. Reuses no caller state between calls. */
  shade(env: Env): Vec;
  /** Nodes actually evaluated - everything not feeding the output is dead and skipped. */
  size: number;
}

const BLACK: Vec = [0, 0, 0, 1];

/** null when the graph has no LED Output node, i.e. nothing to render. */
export function compile(graph: GraphLike): Compiled | null {
  const byId = new Map(graph._nodes.map((n) => [n.id, n]));
  const out = graph._nodes.find((n) => n.type === OUTPUT_TYPE);
  if (!out) return null;

  const steps: Step[] = [];
  const index = new Map<number, number>(); // node id -> step index
  const visiting = new Set<number>();

  // Post-order walk from the output: every node lands after the ones it reads, so a
  // single forward pass over `steps` evaluates the graph. A back edge (litegraph will
  // happily let you wire one) returns null, which reads as "unconnected" downstream.
  function visit(node: NodeLike): number | null {
    const done = index.get(node.id);
    if (done !== undefined) return done;
    if (visiting.has(node.id)) return null;
    const def = NODES[node.type];
    if (!def) return null; // saved by a newer build than this one
    visiting.add(node.id);

    const src = (def.in ?? []).map((_name, slot) => {
      const link = node.inputs?.[slot]?.link;
      const l = link == null ? null : graph.links[link];
      if (!l) return null;
      const from = byId.get(l.origin_id);
      if (!from) return null;
      const step = visit(from);
      return step === null ? null : ([step, l.origin_slot] as [number, number]);
    });

    visiting.delete(node.id);
    const at = steps.length;
    steps.push({ id: node.id, props: node.properties ?? {}, ev: def.eval, src });
    index.set(node.id, at);
    return at;
  }

  if (visit(out) === null) return null;

  // ponytail: one Vec per node output per pixel, so a 64x64 frame allocates a few tens of
  // thousands of short-lived arrays. Fine at panel sizes; if it ever matters, give the
  // steps a flat Float32Array register file and have eval() write into it.
  const regs: Vec[][] = steps.map(() => []);
  const inp: (Vec | null)[] = [];

  return {
    size: steps.length,
    shade(env) {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        inp.length = 0;
        for (const from of s.src) inp.push(from === null ? null : (regs[from[0]][from[1]] ?? null));
        regs[i] = s.ev(inp, s.props, env, s.id);
      }
      return regs[steps.length - 1][0] ?? BLACK;
    },
  };
}
