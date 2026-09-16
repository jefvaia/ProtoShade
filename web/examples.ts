// The example shaders in the header dropdown.
//
// An example is DATA - nodes, their widgets, and the wires between them - so the same
// definition the editor builds a graph from is the one test/examples.test.mjs compiles and
// holds to the device's limits. Nothing here is a screenshot of a graph that used to work.
//
// Art is drawn here rather than committed as PNGs: a few lines of canvas beats a binary in
// the repository, it scales to whatever the example needs, and it keeps an example that
// shows off images from depending on a file somebody has to find first.

import { decodeInto, images, type Props } from "./nodes.js";

export interface Art {
  /** One FRAME's size. The strip drawn is w by h * frames. */
  w: number;
  h: number;
  frames: number;
  draw: (g: CanvasRenderingContext2D, w: number, h: number, frame: number, frames: number) => void;
}

export interface Example {
  name: string;
  /** One line, shown under the preview once it is loaded. */
  desc: string;
  nodes: { id: number; type: string; pos: [number, number]; props?: Props }[];
  /** [from node, from slot, to node, to slot] */
  links: [number, number, number, number][];
  /** Node id -> the image that node starts with. */
  art?: Record<number, Art>;
}

// ---------------------------------------------------------------------------
// Art
// ---------------------------------------------------------------------------

const CYAN = "#39d7ff";

/** Two eyes, the lids closing over the last three frames of the loop. */
const eyes: Art = {
  w: 64,
  h: 32,
  frames: 16,
  draw(g, w, h, f, frames) {
    // Open for most of the cycle, then half, shut, half. A blink you can watch rather than
    // a strobe: at the default speed the shut frame is on screen for about a tenth of a second.
    const open = f < frames - 3 ? 1 : [0.55, 0.12, 0.55][f - (frames - 3)];
    g.fillStyle = CYAN;
    for (const cx of [w * 0.25, w * 0.75]) {
      g.beginPath();
      g.ellipse(cx, h / 2, w * 0.17, Math.max(1, h * 0.3 * open), 0, 0, Math.PI * 2);
      g.fill();
    }
  },
};

/** A mouth opening from shut to wide, one frame per step. This is the blend-shape art:
    every frame is a drawing somebody made, and the sensor picks between them. */
const mouth: Art = {
  w: 64,
  h: 32,
  frames: 8,
  draw(g, w, h, f, frames) {
    const open = f / (frames - 1);
    g.fillStyle = CYAN;
    g.beginPath();
    g.ellipse(w / 2, h / 2, w * 0.28, Math.max(0.8, h * 0.34 * open), 0, 0, Math.PI * 2);
    g.fill();
  },
};

/** A soft dot: bright core, alpha falling off to nothing at the edge. */
const spark: Art = {
  w: 16,
  h: 16,
  frames: 1,
  draw(g, w, h) {
    const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grad.addColorStop(0, "rgba(255,240,200,1)");
    grad.addColorStop(0.45, "rgba(255,150,40,0.85)");
    grad.addColorStop(1, "rgba(255,80,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  },
};

/** A flat disc of one colour on a transparent field - a sprite with real coverage, so
    blending two of them has an overlap to blend inside. */
const disc = (colour: string, at: number): Art => ({
  w: 64,
  h: 32,
  frames: 1,
  draw(g, w, h) {
    g.fillStyle = colour;
    g.beginPath();
    g.arc(w * at, h / 2, h * 0.38, 0, Math.PI * 2);
    g.fill();
  },
});

// ---------------------------------------------------------------------------
// The examples
// ---------------------------------------------------------------------------

export const EXAMPLES: Example[] = [
  {
    name: "hue scroll",
    desc: "The starting point: a hue ramp across the panel, walked by the clock.",
    nodes: [
      { id: 1, type: "input/coordinates", pos: [20, 110] },
      { id: 2, type: "vector/separate", pos: [200, 110] },
      { id: 3, type: "input/time", pos: [20, 290], props: { speed: 0.2 } },
      { id: 4, type: "math/math", pos: [400, 150], props: { op: "add" } },
      { id: 5, type: "color/hsv", pos: [600, 130] },
      { id: 6, type: "output/led", pos: [810, 130] },
    ],
    links: [
      [1, 0, 2, 0],
      [2, 0, 4, 0],
      [3, 0, 4, 1],
      [4, 0, 5, 0],
      [5, 0, 6, 0],
    ],
  },

  {
    name: "blinking eyes",
    desc:
      "Sixteen drawings on a strip, walked by the clock. Phase counts whole cycles, so it " +
      "loops; the blink is the last three frames.",
    nodes: [
      {
        id: 1,
        type: "texture/animation",
        pos: [260, 140],
        props: { frames: 16, loop: true, crossfade: false, speed: 0.4, wrap: "clip", filter: "nearest" },
      },
      { id: 2, type: "output/led", pos: [620, 160] },
    ],
    links: [[1, 0, 2, 0]],
    art: { 1: eyes },
  },

  {
    name: "mouth, blend shape",
    desc:
      "The same kind of strip, read the other way: loop off, so the sensor's 0..1 picks " +
      "which drawing is on screen. Turn sweep off and type a value to scrub it by hand.",
    nodes: [
      {
        id: 1,
        type: "input/sensor",
        pos: [30, 200],
        props: { range: "0..1", index: 0, test: 0.5, sweep: true },
      },
      {
        id: 2,
        type: "texture/animation",
        pos: [330, 140],
        props: { frames: 8, loop: false, crossfade: false, wrap: "clip", filter: "nearest" },
      },
      { id: 3, type: "output/led", pos: [690, 160] },
    ],
    // The sensor's Unit output (slot 1) into Phase (input 1): 0..1 across the strip.
    links: [
      [1, 1, 2, 1],
      [2, 0, 3, 0],
    ],
    art: { 2: mouth },
  },

  {
    name: "embers",
    desc:
      "Twenty-four sprites with no state at all - each one's position is a function of its " +
      "index and the clock - rising from the bottom edge. The emitter sits wherever the " +
      "position input reads zero, which is what the Combine and subtract are for.",
    nodes: [
      { id: 1, type: "input/coordinates", pos: [20, 330] },
      { id: 2, type: "vector/separate", pos: [200, 330] },
      { id: 3, type: "math/math", pos: [370, 350], props: { op: "multiply", b: 0.22 } },
      { id: 4, type: "color/hsv", pos: [540, 330], props: { hue: 0.03, sat: 1, val: 1, alpha: 1 } },
      // The emitter sits wherever the position input reads zero. Shifting the coordinates
      // down by 0.9 puts it along the bottom edge instead of the middle of the face.
      { id: 8, type: "vector/combine", pos: [20, 560], props: { r: 0, g: 0.9, b: 0, a: 1 } },
      { id: 9, type: "math/math", pos: [200, 560], props: { op: "subtract" } },
      {
        id: 5,
        type: "texture/particles",
        pos: [260, 60],
        // Straight up, in a narrow cone, slowing under gravity, turning as they go.
        props: {
          frames: 1,
          count: 24,
          life: 1.8,
          fade: 1,
          seed: 5,
          direction: 0,
          spread: 50,
          speed: 0.55,
          speedSpread: 0.25,
          accel: 0,
          gravityX: 0.05,
          gravityY: 0.35,
          size: 0.32,
          sizeSpread: 0.1,
          sizeRate: -0.1,
          sizeAccel: 0,
          rotation: 0,
          rotSpread: 360,
          rotRate: 40,
          rotAccel: 0,
          filter: "linear",
        },
      },
      { id: 6, type: "color/over", pos: [760, 180], props: { mode: "screen", fac: 1 } },
      { id: 7, type: "output/led", pos: [960, 200] },
    ],
    links: [
      [1, 0, 2, 0],
      [2, 1, 3, 0],
      [3, 0, 4, 2],
      [1, 1, 9, 0],
      [8, 0, 9, 1],
      [9, 0, 5, 0],
      [5, 0, 6, 1],
      [4, 0, 6, 2],
      [6, 0, 7, 0],
    ],
    art: { 5: spark },
  },

  {
    name: "two sprites, blended",
    desc:
      "One disc sliding through another. Blend is the node for two things that overlap - " +
      "switch its mode between normal, add and multiply and watch only the overlap change.",
    nodes: [
      { id: 1, type: "input/coordinates", pos: [20, 220] },
      { id: 2, type: "input/time", pos: [20, 400], props: { speed: 0.7 } },
      { id: 3, type: "math/math", pos: [200, 400], props: { op: "sine" } },
      { id: 4, type: "math/math", pos: [370, 400], props: { op: "multiply", b: 0.3 } },
      { id: 5, type: "vector/combine", pos: [540, 390], props: { r: 0, g: 0, b: 0, a: 1 } },
      { id: 6, type: "math/math", pos: [540, 210], props: { op: "subtract" } },
      { id: 7, type: "texture/image", pos: [720, 80], props: { wrap: "clip", filter: "nearest" } },
      { id: 8, type: "texture/image", pos: [720, 280], props: { wrap: "clip", filter: "nearest" } },
      { id: 9, type: "color/over", pos: [920, 160], props: { mode: "add", fac: 1 } },
      { id: 10, type: "output/led", pos: [1110, 180] },
    ],
    links: [
      [2, 0, 3, 0],
      [3, 0, 4, 0],
      [4, 0, 5, 0],
      [1, 0, 6, 0],
      [5, 0, 6, 1],
      [6, 0, 7, 0],
      [1, 0, 8, 0],
      [7, 0, 9, 1],
      [8, 0, 9, 2],
      [9, 0, 10, 0],
    ],
    art: { 7: disc("#ff2d5e", 0.42), 8: disc("#2d7bff", 0.58) },
  },

  {
    name: "baked plasma",
    desc:
      "Thirteen instructions of sines become four: Bake renders the branch here and ships " +
      "the frames. The clock still picks the frame on the head - delete the Bake node to " +
      "compare the instruction count.",
    nodes: [
      { id: 1, type: "input/coordinates", pos: [20, 200] },
      { id: 2, type: "vector/separate", pos: [190, 200] },
      { id: 3, type: "input/time", pos: [20, 420], props: { speed: 1 } },
      { id: 4, type: "math/math", pos: [360, 80], props: { op: "multiply", b: 3 } },
      { id: 5, type: "math/math", pos: [520, 80], props: { op: "add" } },
      { id: 6, type: "math/math", pos: [680, 80], props: { op: "sine" } },
      { id: 7, type: "math/math", pos: [360, 300], props: { op: "multiply", b: 3.7 } },
      { id: 8, type: "math/math", pos: [520, 300], props: { op: "add" } },
      { id: 9, type: "math/math", pos: [680, 300], props: { op: "cosine" } },
      { id: 10, type: "math/math", pos: [840, 190], props: { op: "add" } },
      { id: 11, type: "math/math", pos: [1000, 190], props: { op: "multiply", b: 0.25 } },
      { id: 12, type: "color/hsv", pos: [1160, 170] },
      // 2 pi seconds is one whole period of both sines, so the baked loop closes seamlessly.
      {
        id: 13,
        type: "bake/bake",
        pos: [1340, 190],
        props: { driver: "time", frames: 24, seconds: 6.2832, crossfade: false },
      },
      { id: 14, type: "output/led", pos: [1530, 200] },
    ],
    links: [
      [1, 1, 2, 0],
      [2, 0, 4, 0],
      [4, 0, 5, 0],
      [3, 0, 5, 1],
      [5, 0, 6, 0],
      [2, 1, 7, 0],
      [7, 0, 8, 0],
      [3, 0, 8, 1],
      [8, 0, 9, 0],
      [6, 0, 10, 0],
      [9, 0, 10, 1],
      [10, 0, 11, 0],
      [11, 0, 12, 0],
      [12, 0, 13, 0],
      [13, 0, 14, 0],
    ],
  },
];

// ---------------------------------------------------------------------------
// Building one in the editor. Everything below touches the DOM and the litegraph globals.
// ---------------------------------------------------------------------------

/** Draws an Art into one vertical strip and returns it as a PNG data URL - the same shape
    an upload takes, so the node cannot tell the difference. */
function drawStrip(art: Art): string {
  const c = document.createElement("canvas");
  c.width = art.w;
  c.height = art.h * art.frames;
  const g = c.getContext("2d");
  if (!g) throw new Error("2d context unavailable");
  for (let f = 0; f < art.frames; f++) {
    g.save();
    g.translate(0, f * art.h);
    g.beginPath();
    g.rect(0, 0, art.w, art.h);
    g.clip();
    art.draw(g, art.w, art.h, f, art.frames);
    g.restore();
  }
  return c.toDataURL("image/png");
}

/** Replaces whatever is in the editor with this example. */
export async function apply(graph: LGraph, ex: Example): Promise<void> {
  graph.clear();
  images.clear();

  const made = new Map<number, LGraphNode>();
  for (const spec of ex.nodes) {
    const node = LiteGraph.createNode(spec.type);
    if (!node) throw new Error(`node type ${spec.type} is not registered`);
    node.pos = spec.pos;
    graph.add(node);
    // setProperty, not properties[x]: it also updates the widget bound to that property,
    // and a widget showing something the shader is not doing is worse than no widget.
    for (const [key, value] of Object.entries(spec.props ?? {})) node.setProperty(key, value);
    made.set(spec.id, node);
  }
  for (const [from, fromSlot, to, toSlot] of ex.links) {
    made.get(from)?.connect(fromSlot, made.get(to)!, toSlot);
  }

  await Promise.all(
    Object.entries(ex.art ?? {}).map(async ([id, art]) => {
      const node = made.get(Number(id));
      if (!node) return;
      const src = drawStrip(art);
      node.properties.file = src;
      if ("frames" in node.properties) node.setProperty("frames", art.frames);
      await decodeInto(node.id, src, art.frames);
      const widget = node.widgets?.[0];
      if (widget) widget.name = `${art.w} x ${art.h}${art.frames > 1 ? ` x ${art.frames}f` : ""}`;
    }),
  );
}
