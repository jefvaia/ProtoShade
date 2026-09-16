// Sits next to protoshade.js in dist/ after the build, so this path resolves at runtime.
import createModule from "./protoshade.js";

const WIDTH = 8;
const HEIGHT = 8;

const canvas = document.getElementById("c") as HTMLCanvasElement | null;
if (!canvas) throw new Error("canvas #c missing");
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2d context unavailable");

canvas.width = WIDTH;
canvas.height = HEIGHT;

const m = await createModule();
const runtime = new m.ProtoShadeRuntime();
runtime.setResolution(WIDTH, HEIGHT);

const img = ctx.createImageData(WIDTH, HEIGHT);

function frame(t: number): void {
  runtime.render(Math.floor(t));
  // Re-read every frame: the view points into wasm memory and does not survive it growing.
  const rgb = runtime.pixels();
  for (let i = 0, p = 0; i < rgb.length; i += 3, p += 4) {
    img.data[p] = rgb[i];
    img.data[p + 1] = rgb[i + 1];
    img.data[p + 2] = rgb[i + 2];
    img.data[p + 3] = 255;
  }
  ctx!.putImageData(img, 0, 0);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
