// Wires the page together: litegraph editor on the left, LED preview on the right, and the
// download button that turns the graph into the .bin the head runs.
//
// The preview does not evaluate nodes. It compiles the graph to a Program and interprets
// that - the same Program pack() writes and the C++ VM executes - so what you see here is
// what the panel will do, minus the panel.

import { compile, Runner, type Program } from "./graph.js";
import { instructionCount, pack, packedSize } from "./pack.js";
import { RANGES, decodeInto, imageLabel, images, register, type Env, type Vec } from "./nodes.js";
import { DeviceLink, supported as serialSupported, type SerialFrame } from "./serial.js";
import { Visor } from "./visor.js";

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
const binInfo = el<HTMLElement>("bin-info");
const mirrorInfo = el<HTMLElement>("mirror-info");
const mirrorButton = el<HTMLButtonElement>("mirror");
const flashButton = el<HTMLButtonElement>("flash");

// The 3D view of the panels. It reads the same canvas the flat preview draws, so it follows
// the interpreter and the mirrored head without caring which one produced the frame.
const visor = Visor.create(el<HTMLCanvasElement>("visor"));
if (!visor) el("visor").classList.add("hidden");

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

// litegraph's value menus close when you pick something or click the canvas, but not when
// you simply walk away from them. They are position:fixed DOM elements, so one left open
// hangs over whatever is underneath - usually the preview, as a stack of stray words. Close
// them as soon as the pointer is somewhere that is neither the menu nor the graph.
const openMenus = document.getElementsByClassName("litecontextmenu");
addEventListener("pointermove", (event) => {
  if (openMenus.length === 0) return;
  const target = event.target;
  if (target instanceof Element && target.closest(".litecontextmenu, #graph-wrap")) return;
  LiteGraph.closeAllContextMenus();
});

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
        /* unreadable upload: the node renders transparent */
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
// Sensors. Nothing is plugged into a browser, so the editor plays the part of the firmware:
// it fills the same feed the device will (Env.sensors / Frame::sensors), from each Sensor
// node's own widgets. The compiled program is identical either way.
// ---------------------------------------------------------------------------

function sensorFeed(t: number): number[] {
  const feed: number[] = [];
  for (const node of graph._nodes) {
    if (node.type !== "input/sensor") continue;
    const slot = Math.max(0, Math.round(Number(node.properties.index) || 0));
    if (slot > 255) continue;
    feed[slot] = node.properties.sweep ? sweep(String(node.properties.range), t * 1.5) : Number(node.properties.test) || 0;
  }
  return feed;
}

/** Walks the declared range, so you can watch a shader react without wiring hardware. */
function sweep(range: string, t: number): number {
  switch (range) {
    case "-1..1":
      return Math.sin(t);
    case "0..inf":
      return 5 - 5 * Math.cos(t);
    case "-inf..inf":
      return 5 * Math.sin(t);
    case "0..360":
      return (t * 40) % 360;
    default:
      return 0.5 - 0.5 * Math.cos(t);
  }
}

// ---------------------------------------------------------------------------
// Mirroring the head over USB. When frames are arriving they are what the preview shows -
// the point is to see what the hardware is doing, not what this machine would do.
// ---------------------------------------------------------------------------

const link = new DeviceLink();
let deviceFrame: SerialFrame | null = null;
let deviceAt = 0;
let deviceFrames = 0;
let deviceFps = 0;
let deviceFpsAt = 0;

function mirrorStatus(text: string): void {
  mirrorInfo.textContent = text;
}

if (!serialSupported()) {
  for (const button of [mirrorButton, flashButton]) {
    button.disabled = true;
    button.title = "Web Serial needs Chrome or Edge on the desktop";
    button.classList.add("opacity-40");
  }
}

/** Opens the port, if it is not open already. Mirroring and flashing share the one cable. */
async function openLink(): Promise<void> {
  if (link.connected) return;
  await link.connect(
    (frame) => {
      deviceFrame = frame;
      deviceAt = performance.now();
      deviceFrames++;
    },
    (why) => {
      deviceFrame = null;
      mirrorButton.textContent = "mirror head";
      mirrorStatus(why === "disconnected" ? "" : why);
    },
  );
}

mirrorButton.onclick = async () => {
  if (link.connected) {
    await link.send("p"); // tell it to stop sending before the port goes away
    await link.disconnect();
    deviceFrame = null;
    mirrorButton.textContent = "mirror head";
    mirrorStatus("");
    return;
  }
  try {
    await openLink();
    mirrorButton.textContent = "stop mirroring";
    mirrorStatus("connected, waiting for frames...");
    await link.send("p"); // same command the serial monitor takes
  } catch (err) {
    // Includes the user simply closing the port picker, which is not worth shouting about.
    mirrorStatus(String(err).replace(/^Error:\s*/, ""));
  }
};

// Flashing over the cable, in place of joining the head's access point - which is the only
// way in on a computer with no WiFi. The head pauses the face, writes the .bin into its
// flash partition and starts running it; the whole trip is a second or two.
flashButton.onclick = async () => {
  if (!current) {
    mirrorStatus("nothing to flash - the graph does not compile");
    return;
  }
  const bin = pack(current);
  flashButton.disabled = true;
  const label = flashButton.textContent;
  try {
    await openLink();
    flashButton.textContent = "flashing...";
    const summary = await link.flash(bin, (sent, total) => {
      flashButton.textContent = `flashing ${Math.round((100 * sent) / total)}%`;
    });
    mirrorStatus(`flashed over USB: ${summary}`);
  } catch (err) {
    mirrorStatus(String(err).replace(/^Error:\s*/, ""));
  } finally {
    flashButton.textContent = label;
    flashButton.disabled = false;
  }
};

/** Draws a frame from the head, scaled to the preview canvas. */
function drawDeviceFrame(frame: SerialFrame): void {
  if (panel.width !== frame.w || panel.height !== frame.h) {
    panel.width = frame.w;
    panel.height = frame.h;
  }
  const img = pctx!.createImageData(frame.w, frame.h);
  for (let i = 0, p = 0; i < frame.rgb.length; i += 3, p += 4) {
    img.data[p] = frame.rgb[i];
    img.data[p + 1] = frame.rgb[i + 1];
    img.data[p + 2] = frame.rgb[i + 2];
    img.data[p + 3] = 255;
  }
  pctx!.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------------------
// Preview loop
// ---------------------------------------------------------------------------

const env: Env = { x: 0, y: 0, u: 0, v: 0, w: W, h: H, t: 0, frame: 0 };
const colour: Vec = [0, 0, 0, 1];
let frames = 0;
let fpsAt = 0;
const t0 = performance.now();
/** Kept for the download button, so it ships exactly what the preview last drew. */
let current: Program | null = null;

function render(now: number): void {
  requestAnimationFrame(render);

  const result = compile(graph, images, W, H);
  current = result.ok ? result.program : null;
  // A frame older than a second means the head stopped talking; fall back to rendering here
  // rather than leaving a stale picture up that looks live.
  const mirroring = deviceFrame !== null && now - deviceAt < 1000;
  const runner = mirroring ? null : current ? new Runner(current) : null;
  const img = pctx!.createImageData(W, H);
  env.w = W;
  env.h = H;
  env.t = (now - t0) / 1000;
  env.sensors = sensorFeed(env.t);

  if (mirroring) {
    drawDeviceFrame(deviceFrame!);
  } else
  for (let y = 0, p = 0; y < H; y++) {
    for (let x = 0; x < W; x++, p += 4) {
      colour[0] = colour[1] = colour[2] = 0;
      if (runner) {
        env.x = x;
        env.y = y;
        // Pixel centres, so u never hits exactly 0 or 1 and an image tiles cleanly.
        env.u = (x + 0.5) / W;
        env.v = (y + 0.5) / H;
        runner.run(env, colour);
      }
      // Math.round, not the implicit rounding of a clamped array: the device rounds
      // half-up and ties-to-even here would differ by a level on some pixels.
      img.data[p] = Math.round(colour[0] * 255);
      img.data[p + 1] = Math.round(colour[1] * 255);
      img.data[p + 2] = Math.round(colour[2] * 255);
      img.data[p + 3] = 255;
    }
  }
  env.frame++;

  if (!mirroring) {
    if (panel.width !== W || panel.height !== H) {
      panel.width = W;
      panel.height = H;
    }
    pctx!.putImageData(img, 0, 0);
  }
  visor?.draw(panel);
  lctx!.imageSmoothingEnabled = false;
  lctx!.drawImage(panel, 0, 0, led.width, led.height);

  // Dark seams between the LEDs. Only worth drawing once a cell is a few pixels wide.
  const cell = led.width / panel.width;
  if (cell >= 5) {
    lctx!.strokeStyle = "rgba(0,0,0,0.55)";
    lctx!.lineWidth = 1;
    lctx!.beginPath();
    for (let x = 1; x < panel.width; x++) {
      lctx!.moveTo(x * cell, 0);
      lctx!.lineTo(x * cell, led.height);
    }
    const rowCell = led.height / panel.height;
    for (let y = 1; y < panel.height; y++) {
      lctx!.moveTo(0, y * rowCell);
      lctx!.lineTo(led.width, y * rowCell);
    }
    lctx!.stroke();
  }

  frames++;
  if (now - fpsAt > 500) {
    const fps = Math.round((frames * 1000) / (now - fpsAt));
    frames = 0;
    fpsAt = now;
    previewInfo.textContent = `${W}×${H} · ${W * H} led${W * H === 1 ? "" : "s"} · ${fps} fps`;
    if (link.connected) {
      deviceFps = Math.round((deviceFrames * 1000) / Math.max(1, now - deviceFpsAt));
      deviceFrames = 0;
      deviceFpsAt = now;
      mirrorStatus(
        mirroring && deviceFrame
          ? `live from the head · ${deviceFrame.w}×${deviceFrame.h} · ${deviceFps} fps over USB`
          : "connected, waiting for frames...",
      );
    }
    hint.textContent = result.ok ? "" : result.reason;
    binInfo.textContent = current
      ? `${instructionCount(current)} instructions · ${current.assets.length} image${current.assets.length === 1 ? "" : "s"} · ` +
        `${(packedSize(current) / 1024).toFixed(1)} KB .bin` +
        (current.sensorCount ? ` · ${current.sensorCount} sensor slot${current.sensorCount === 1 ? "" : "s"}` : "")
      : "";
  }
}

fitEditor();
requestAnimationFrame(render);

// ---------------------------------------------------------------------------
// Download. This is the whole handoff: the file goes to the head's upload page as-is.
// ---------------------------------------------------------------------------

el<HTMLButtonElement>("download").onclick = () => {
  if (!current) return;
  const url = URL.createObjectURL(new Blob([pack(current) as BlobPart], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "protoshade.bin";
  a.click();
  URL.revokeObjectURL(url);
};

// Sanity check that nobody renamed a range behind the compiler's back: the combo values and
// the unit table are the same list, and a mismatch would silently shift every sensor.
if (RANGES.length !== 5) throw new Error("RANGES changed - bump format::kVersion");

// The device runtime is compiled by build.bat and served next to this file. The preview does
// not need it - it runs the same program in TypeScript - so just report whether it is there.
try {
  const createModule = (await import("./protoshade.js")).default;
  const rt = new (await createModule()).ProtoShadeRuntime();
  rt.setResolution(W, H);
  status.textContent = "device runtime: loaded";
  rt.delete();
} catch {
  status.textContent = "device runtime: not built";
}
