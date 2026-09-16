// Sits next to protoshade.js in dist/ after the build, so this path resolves at runtime.
import createModule from "./protoshade.js";

const SIZE = 8;

const canvas = document.getElementById("c") as HTMLCanvasElement | null;
if (!canvas) throw new Error("canvas #c missing");
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2d context unavailable");

const m = await createModule();
const face = new m.ProtoShadeRuntime(SIZE, SIZE);
const img = ctx.createImageData(SIZE, SIZE);

function frame(t: number): void {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const v = face.pixel(x, y, Math.floor(t));
      img.data.set([0, v, v, 255], (y * SIZE + x) * 4);
    }
  }
  ctx!.putImageData(img, 0, 0);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
