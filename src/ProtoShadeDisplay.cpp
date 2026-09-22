// -O2 for the same reason ProtoShadeRuntime.cpp asks for it: the Arduino builder compiles
// every sketch -Os, and this file walks every pixel of every frame on its way to a panel.
#if defined(__OPTIMIZE_SIZE__) && !defined(__clang__)
#pragma GCC optimize("O2")
#endif

#include "ProtoShadeDisplay.h"

namespace protoshade {
namespace {

constexpr Pixel kBlack{0, 0, 0};

}  // namespace

void pushPanel(const Panel& panel, const Pixel* canvas, uint16_t canvas_w, uint16_t canvas_h,
               Pixel* scratch) {
  if (!panel.display || !canvas || panel.width == 0 || panel.height == 0) return;

  // A panel mounted straight, spanning whole canvas rows, is already laid out the way the
  // driver wants it - hand it the canvas and skip the copy entirely. This is the common
  // case for a single-panel head.
  const bool plain = panel.orient == Orient::Normal && !panel.mirror_x && !panel.mirror_y;
  if (plain && panel.src_x == 0 && panel.width == canvas_w &&
      uint32_t(panel.src_y) + panel.height <= canvas_h) {
    panel.display->push(canvas + size_t(panel.src_y) * canvas_w, panel.width, panel.height);
    return;
  }
  if (!scratch) return;

  for (uint16_t py = 0; py < panel.height; py++) {
    for (uint16_t px = 0; px < panel.width; px++) {
      // Mirror in panel space first, then undo the mounting rotation to land on the canvas.
      const int32_t mx = panel.mirror_x ? int32_t(panel.width) - 1 - px : px;
      const int32_t my = panel.mirror_y ? int32_t(panel.height) - 1 - py : py;
      int32_t sx = mx;
      int32_t sy = my;
      switch (panel.orient) {
        case Orient::Normal:
          break;
        case Orient::Rotate90:  // the canvas rectangle appears turned a quarter clockwise
          sx = my;
          sy = int32_t(panel.width) - 1 - mx;
          break;
        case Orient::Rotate180:
          sx = int32_t(panel.width) - 1 - mx;
          sy = int32_t(panel.height) - 1 - my;
          break;
        case Orient::Rotate270:
          sx = int32_t(panel.height) - 1 - my;
          sy = mx;
          break;
      }

      const int32_t cx = int32_t(panel.src_x) + sx;
      const int32_t cy = int32_t(panel.src_y) + sy;
      // Off the canvas reads black. A panel mapped half past the edge shows black there
      // rather than whatever happens to be in memory next to the framebuffer.
      const bool inside = cx >= 0 && cy >= 0 && cx < int32_t(canvas_w) && cy < int32_t(canvas_h);
      scratch[size_t(py) * panel.width + px] = inside ? canvas[size_t(cy) * canvas_w + cx] : kBlack;
    }
  }
  panel.display->push(scratch, panel.width, panel.height);
}

void pushPanels(const Panel* panels, size_t count, const Pixel* canvas, uint16_t canvas_w,
                uint16_t canvas_h, Pixel* scratch) {
  if (!panels) return;
  for (size_t i = 0; i < count; i++) pushPanel(panels[i], canvas, canvas_w, canvas_h, scratch);
}

void readSensors(const SensorInput* inputs, size_t count, float* values, uint8_t slots) {
  if (!values) return;
  for (uint8_t i = 0; i < slots; i++) values[i] = 0.0f;
  if (!inputs) return;
  for (size_t i = 0; i < count; i++) {
    // A slot past the end of the array is a wiring mistake in the sketch, not a reason to
    // write past the buffer the shader is about to read.
    if (inputs[i].read && inputs[i].slot < slots) values[inputs[i].slot] = inputs[i].read();
  }
}

}  // namespace protoshade
