// Wires the page together: litegraph editor on the left, LED preview on the right, and the
// download button that turns the graph into the .bin the head runs.
//
// The preview does not evaluate nodes. It compiles the graph to a Program and interprets
// that - the same Program pack() writes and the C++ VM executes - so what you see here is
// what the panel will do, minus the panel.

import { compile, Runner, type Program } from "./graph.js";
import { PARTITION_BYTES, instructionCount, pack, packedSize } from "./pack.js";
import { RANGES, decodeInto, imageLabel, images, register, type Env, type Vec } from "./nodes.js";
import { EXAMPLES, apply } from "./examples.js";
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
const examplePicker = el<HTMLSelectElement>("example");
const exampleInfo = el<HTMLElement>("example-info");
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

// Double-clicking a number widget opens litegraph's value prompt: a DOM element over the
// canvas, not something the canvas draws. It closes on Enter, on Escape, or on the pointer
// leaving it again - but NOT once you have typed in it, and its input re-focuses itself on
// blur. Type a digit, click away, and it is stuck on screen for good, which is worse on the
// Image, Animation and Particles nodes because those are the ones with widgets worth typing
// into. Dismiss it the way every other dialog on the web does: a click outside closes it.
const openDialogs = document.getElementsByClassName("graphdialog");
addEventListener(
  "pointerdown",
  (event) => {
    if (openDialogs.length === 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest(".graphdialog")) return;
    // close(), not remove(): litegraph keeps a reference to the open prompt and restores
    // body scrolling for the search box, and only its own close() undoes either.
    for (const dialog of [...openDialogs]) {
      const box = dialog as HTMLElement & { close?: () => void };
      if (typeof box.close === "function") box.close();
      else box.remove();
    }
  },
  true, // capture: get there before litegraph opens the next one on the same click
);

function fitEditor(): void {
  const box = graphCanvas.parentElement;
  if (!box) return;
  graphCanvas.width = box.clientWidth;
  graphCanvas.height = box.clientHeight;
  editor.resize(box.clientWidth, box.clientHeight);
}
addEventListener("resize", fitEditor);

// ---------------------------------------------------------------------------
// Examples. The page opens on the first one; the dropdown loads any of them, art and all.
// ---------------------------------------------------------------------------

for (const [i, ex] of EXAMPLES.entries()) {
  const option = document.createElement("option");
  option.value = String(i);
  option.textContent = ex.name;
  examplePicker.append(option);
}

async function loadExample(index: number): Promise<void> {
  const ex = EXAMPLES[index];
  if (!ex) return;
  await apply(graph, ex);
  exampleInfo.textContent = ex.desc;
  save();
}

examplePicker.onchange = () => {
  void loadExample(Number(examplePicker.value));
  examplePicker.value = "";
};

// ---------------------------------------------------------------------------
// Persistence. Uploaded images ride along as data URLs inside node.properties, so a
// reload restores them too - at the price of a big localStorage entry, which is why
// every access is wrapped: a full quota must cost you autosave, not the editor.
// ---------------------------------------------------------------------------

const SAVE_KEY = "protoshade.graph";
let lastSaved = "";
/** The last autosave hit the browser's storage quota. Worth saying out loud: the README
    promises the graph comes back with the page, and with megabytes of art it does not. */
let saveFailed = false;

function save(): void {
  let json = "";
  try {
    json = JSON.stringify(graph.serialize());
    if (json === lastSaved) return;
    localStorage.setItem(SAVE_KEY, json);
    saveFailed = false;
  } catch {
    // Private mode, or the graph outgrew the quota - keep editing regardless. A graph with
    // a few megabytes of art in it is past what localStorage will take, and the browser
    // says so by throwing.
    saveFailed = json !== "";
  }
  // Tried, either way. Without this a graph too big to store is re-serialised and re-thrown
  // every second for the rest of the session, and megabytes of JSON on the main thread once
  // a second is enough to starve a USB transfer of the acks that pace it.
  lastSaved = json;
}

/** Re-decode every image a restored graph carries. */
async function restoreImages(): Promise<void> {
  images.clear();
  await Promise.all(
    graph._nodes.map(async (node) => {
      const src = node.properties.file;
      if (typeof src !== "string" || !src) return;
      try {
        // The saved data URL is already the assembled strip; `frames` is how to cut it up.
        await decodeInto(node.id, src, Math.max(1, Math.round(Number(node.properties.frames) || 1)));
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
      /* corrupt or from an older layout - fall through to the first example */
    }
  }
  void loadExample(0);
}

load();
setInterval(save, 1000);
// A tab closed within a second of an edit would otherwise lose it.
addEventListener("beforeunload", save);

el<HTMLButtonElement>("reset").onclick = () => {
  void loadExample(0);
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
    const size = current ? packedSize(current) : 0;
    // Baking buys instructions with flash, so both numbers have to be on screen at once -
    // and it still has to fit the head's partition (partitions.csv).
    //
    // Art far bigger than the panel is the other way a .bin gets out of hand, and a quieter
    // one: a 320x240 frame on a 64x32 panel is thirty-seven pixels stored for every pixel
    // the head can light. Nothing renders wrong, it just costs megabytes of flash and
    // minutes of transfer for something the panel cannot show. Four times the panel is the
    // threshold, so a sprite that is meant to be bigger than its target says nothing.
    const bloated = current?.assets.find(
      (a) => a.w * Math.floor(a.h / Math.max(1, a.frames)) > 4 * W * H,
    );
    hint.textContent = !result.ok
      ? result.reason
      : size > PARTITION_BYTES
        ? `${(size / 1048576).toFixed(2)} MB will not fit the head's ${PARTITION_BYTES / 1048576} MB partition - fewer baked frames, or a smaller panel`
        : bloated
          ? `an image is ${bloated.w}x${Math.floor(bloated.h / Math.max(1, bloated.frames))} for a ${W}x${H} panel - ` +
            `${Math.round((bloated.w * Math.floor(bloated.h / Math.max(1, bloated.frames))) / (W * H))}x the pixels the head can show. ` +
            `Re-import it at ${W}x${H} and the .bin gets that much smaller`
          : saveFailed
            ? "too big to autosave - the graph will not come back when you reload the page"
            : "";
    binInfo.textContent = current
      ? `${instructionCount(current)} instructions · ${current.assets.length} image${current.assets.length === 1 ? "" : "s"} · ` +
        `${(size / 1024).toFixed(1)} KB .bin` +
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
