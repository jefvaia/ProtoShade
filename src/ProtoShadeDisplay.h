#pragma once
#include <cstddef>

#include "ProtoShadeRuntime.h"

// Mapping the rendered face onto the panels actually screwed into a head.
//
// Portable on purpose - no Arduino.h, no driver library. The runtime renders ONE canvas (the
// face as the editor drew it) and each Panel copies a rectangle out of it, oriented for how
// that display is physically mounted, then hands the pixels to a Display you implement.
//
// Two consequences worth stating, because they are the questions every head asks:
//
//   - Canvas area no panel reads is simply never displayed. It still costs render time, so
//     keep the canvas to the size of the face, but nothing breaks and nothing has to be
//     masked off.
//   - Two panels may read the SAME rectangle. That is how you drive both sides of a face
//     from one drawing: point both at it and set mirror_x on one.

namespace protoshade {

// One physical display. Implement it once per driver you actually use - HUB75 over DMA,
// a WS2812 string, an SPI TFT - and keep the library free of that dependency.
class Display {
public:
  virtual ~Display() = default;

  // Called once from setup(). Return false and the head reports it instead of rendering
  // into a driver that never came up.
  virtual bool begin() { return true; }

  // rgb holds width * height pixels, row major, already rotated and mirrored for this
  // panel: (0,0) is the pixel in the panel's own top-left corner.
  virtual void push(const Pixel* rgb, uint16_t width, uint16_t height) = 0;
};

// How a panel is mounted relative to the canvas, clockwise.
enum class Orient : uint8_t { Normal = 0, Rotate90, Rotate180, Rotate270 };

// Plain members, no default initialisers: that keeps it an aggregate under -std=gnu++11,
// which the ESP32 Arduino core 2.x still compiles with, so the Panel{...} lists in
// head_config.h work there too. Fields left out of the braces are zero-initialised, which
// is Orient::Normal and no mirroring.
struct Panel {
  Display* display;
  uint16_t src_x;   // top-left of the rectangle this panel reads from the canvas
  uint16_t src_y;
  uint16_t width;   // the panel's own resolution, after rotation
  uint16_t height;
  Orient orient;
  // Mirroring happens in panel space, before rotation. The usual use is one drawing of half
  // a face feeding a left panel straight and a right panel with mirror_x set.
  bool mirror_x;
  bool mirror_y;

  // How much canvas this panel covers. A quarter turn swaps the two.
  uint16_t sourceWidth() const {
    return orient == Orient::Rotate90 || orient == Orient::Rotate270 ? height : width;
  }
  uint16_t sourceHeight() const {
    return orient == Orient::Rotate90 || orient == Orient::Rotate270 ? width : height;
  }
};

// Copies one panel's rectangle out of the canvas into scratch and pushes it.
//
// scratch holds at least width * height pixels and belongs to the caller - the same reason
// ExecContext does. Canvas pixels outside the canvas read black rather than reading out of
// bounds, so a panel mapped half off the edge shows black there instead of garbage.
//
// When the rectangle is already contiguous and unrotated, the canvas rows are handed to the
// driver directly and scratch is not touched.
void pushPanel(const Panel& panel, const Pixel* canvas, uint16_t canvas_w, uint16_t canvas_h,
               Pixel* scratch);

// pushPanel for every panel in a head. Panels are pushed in order, so if one driver blocks
// (DMA-less SPI, say) put the one nobody looks at last.
void pushPanels(const Panel* panels, size_t count, const Pixel* canvas, uint16_t canvas_w,
                uint16_t canvas_h, Pixel* scratch);

// ---------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------

// One sensor, wired to the slot the editor's Sensor node points at. read() returns the
// value in whatever range that node declares - 0..1 for a flex strip, degrees for a
// compass, an unbounded count for an encoder. Converting raw ADC counts into that range is
// this function's job; the shader only ever sees the result.
struct SensorInput {
  uint8_t slot;
  float (*read)();
};

// Fills `values` (length slots) from `inputs`. Slots with no sensor are left at 0, and a
// slot past the end of the array is skipped rather than written out of bounds - a head
// missing a sensor the program wants falls back to the value baked into the .bin.
void readSensors(const SensorInput* inputs, size_t count, float* values, uint8_t slots);

}  // namespace protoshade
