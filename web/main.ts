// Wires the page together: litegraph editor on the left, LED preview on the right.
//
// The preview evaluates the graph in TypeScript (graph.ts). The wasm runtime has no shader
// VM yet - once it does, this loop hands it a packed .bin instead and the JS evaluator
// becomes the reference implementation the two are checked against.

import { compile } from "./graph.js";
import { decodeInto, imageLabel, images, register, type Env } from "./nodes.js";

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
};

const graphCanvas = el<HTMLCanvasElement>("graph");
const led = el<HTMLCanvasElement>("led");
const resW = el<HTMLInputElement>("res-w");
const resH = el<HTMLInputElement>("res-h");
const preset = el<HTMLSelectElement>("res-preset");
const status = el<HTMLElement>("status");
const previewInfo = el<HTMLElement>("preview-info");
const hint = el<HTMLElement>("hint");

const lctx = led.getContext("2d");
if (!lctx) throw new Error("2d context unavailable");
// Panel pixels live here at 1:1 and get scaled up onto #led; drawing 4096 cells one
// fillRect at a time would cost more than the whole shader.
const panel = document.createElement("canvas");
const pctx = panel.getContext("2d");
if (!pctx) throw new Error("2d context unavailable");

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

register();
const graph = new LGraph();
const editor = new LGraphCanvas(graphCanvas, graph);
editor.show_info = false; // litegraph's own fps/node counter, we print our own

function fitEditor(): void {
  const box = graphCanvas.parentElement;
  if (!box) return;
  graphCanvas.width = box.clientWidth;
  graphCanvas.height = box.clientHeight;
  editor.resize(box.clientWidth, box.clientHeight);
}
addEventListener("resize", fitEditor);

/** The graph the page opens with: a hue ramp scrolling across the panel. */
function defaultGraph(): void {
  graph.clear();
  const add = (type: string, x: number, y: number): LGraphNode => {
    const node = LiteGraph.createNode(type);
    if (!node) throw new Error(`node type ${type} is not registered`);
    node.pos = [x, y];
    graph.add(node);
    return node;
  };
  const coords = add("input/coordinates", 20, 110);
  const split = add("vector/separate", 200, 110);
  const time = add("input/time", 20, 290);
  const math = add("math/math", 400, 150);
  const hsv = add("color/hsv", 600, 130);
  const out = add("output/led", 810, 130);

  // setProperty, not properties[x]: it also updates the widget bound to that property,
  // and a widget showing something the shader is not doing is worse than no widget.
  time.setProperty("speed", 0.2);
  math.setProperty("op", "add");

  coords.connect(0, split, 0);
  split.connect(0, math, 0);
  time.connect(0, math, 1);
  math.connect(0, hsv, 0);
  hsv.connect(0, out, 0);
}

// ---------------------------------------------------------------------------
// Persistence. Uploaded images ride along as data URLs inside node.properties, so a
// reload restores them too - at the price of a big localStorage entry, which is why
// every access is wrapped: a full quota must cost you autosave, not the editor.
// ---------------------------------------------------------------------------

const SAVE_KEY = "protoshade.graph";
let lastSaved = "";

function save(): void {
  try {
    const json = JSON.stringify(graph.serialize());
    if (json === lastSaved) return;
    localStorage.setItem(SAVE_KEY, json);
    lastSaved = json;
  } catch {
    /* private mode, or the graph outgrew the quota - keep editing regardless */
  }
}

/** Re-decode every image a restored graph carries. */
async function restoreImages(): Promise<void> {
  images.clear();
  await Promise.all(
    graph._nodes.map(async (node) => {
      const src = node.properties.file;
      if (typeof src !== "string" || !src) return;
      try {
        await decodeInto(node.id, src);
        const widget = node.widgets?.[0];
        if (widget) widget.name = imageLabel(node.id);
      } catch {
        /* unreadable upload: the node just renders black */
      }
    }),
  );
}

function load(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(SAVE_KEY);
  } catch {
    /* no storage available */
  }
  if (saved) {
    try {
      graph.configure(JSON.parse(saved));
      void restoreImages();
      return;
    } catch {
      /* corrupt or from an older layout - fall through to the default graph */
    }
  }
  defaultGraph();
}

load();
setInterval(save, 1000);
// A tab closed within a second of an edit would otherwise lose it.
addEventListener("beforeunload", save);

el<HTMLButtonElement>("reset").onclick = () => {
  images.clear();
  defaultGraph();
  save();
};

// ---------------------------------------------------------------------------
// Resolution. The .bin header caps a dimension at 512 (format::kMaxDimension), and the
// number inputs are free text, so clamp rather than trust.
// ---------------------------------------------------------------------------

let W = 64;
let H = 32;

function setResolution(w: number, h: number): void {
  const clamp = (n: number): number => Math.min(512, Math.max(1, Math.round(n) || 1));
  W = clamp(w);
  H = clamp(h);
  resW.value = String(W);
  resH.value = String(H);
  panel.width = W;
  panel.height = H;
  // Scale to fill the sidebar without going subpixel or comically chunky.
  const cell = Math.max(2, Math.min(24, Math.floor(Math.min(340 / W, 340 / H))));
  led.width = W * cell;
  led.height = H * cell;
}

resW.onchange = resH.onchange = () => setResolution(Number(resW.value), Number(resH.value));
preset.onchange = () => {
  const [w, h] = preset.value.split("x").map(Number);
  if (w && h) setResolution(w, h);
  preset.value = "";
};
setResolution(W, H);

// ---------------------------------------------------------------------------
// Preview loop
// ---------------------------------------------------------------------------

const env: Env = { x: 0, y: 0, u: 0, v: 0, w: W, h: H, t: 0, frame: 0, images };
let frames = 0;
let fps = 0;
let fpsAt = 0;
const t0 = performance.now();

function render(now: number): void {
  requestAnimationFrame(render);

  const shader = compile(graph);
  const img = pctx!.createImageData(W, H);
  env.w = W;
  env.h = H;
  env.t = (now - t0) / 1000;

  for (let y = 0, p = 0; y < H; y++) {
    for (let x = 0; x < W; x++, p += 4) {
      let r = 0;
      let g = 0;
      let b = 0;
      if (shader) {
        env.x = x;
        env.y = y;
        // Pixel centres, so u never hits exactly 0 or 1 and an image tiles cleanly.
        env.u = (x + 0.5) / W;
        env.v = (y + 0.5) / H;
        [r, g, b] = shader.shade(env);
      }
      img.data[p] = r * 255;
      img.data[p + 1] = g * 255;
      img.data[p + 2] = b * 255;
      img.data[p + 3] = 255;
    }
  }
  env.frame++;

  pctx!.putImageData(img, 0, 0);
  lctx!.imageSmoothingEnabled = false;
  lctx!.drawImage(panel, 0, 0, led.width, led.height);

  // Dark seams between the LEDs. Only worth drawing once a cell is a few pixels wide.
  const cell = led.width / W;
  if (cell >= 5) {
    lctx!.strokeStyle = "rgba(0,0,0,0.55)";
    lctx!.lineWidth = 1;
    lctx!.beginPath();
    for (let x = 1; x < W; x++) {
      lctx!.moveTo(x * cell, 0);
      lctx!.lineTo(x * cell, led.height);
    }
    for (let y = 1; y < H; y++) {
      lctx!.moveTo(0, y * cell);
      lctx!.lineTo(led.width, y * cell);
    }
    lctx!.stroke();
  }

  frames++;
  if (now - fpsAt > 500) {
    fps = Math.round((frames * 1000) / (now - fpsAt));
    frames = 0;
    fpsAt = now;
    previewInfo.textContent = `${W}×${H} · ${W * H} led${W * H === 1 ? "" : "s"} · ${fps} fps`;
    hint.textContent = shader
      ? `${shader.size} node${shader.size === 1 ? "" : "s"} feeding the output`
      : "no LED Output node - add one (right-click ▸ output) and wire a colour into it";
  }
}

fitEditor();
requestAnimationFrame(render);

// The device runtime is compiled by build.bat and served next to this file. It has no
// shader VM yet, so the preview does not use it - report whether it is there and move on.
try {
  const createModule = (await import("./protoshade.js")).default;
  const rt = new (await createModule()).ProtoShadeRuntime();
  rt.setResolution(W, H);
  status.textContent = "device runtime: loaded";
  rt.delete();
} catch {
  status.textContent = "device runtime: not built";
}
