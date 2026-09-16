#pragma once
#include <cstdint>

// Portable core: NO Arduino.h, NO emscripten here. Plain C++ only.
class ProtoShadeRuntime {
public:
  ProtoShadeRuntime(uint16_t width, uint16_t height) : w_(width), h_(height) {}

  // Brightness 0..254 of pixel (x, y) at time ms: a diagonal wave scrolling over time.
  uint8_t pixel(uint16_t x, uint16_t y, uint32_t ms) const;

  uint16_t width() const { return w_; }
  uint16_t height() const { return h_; }

private:
  uint16_t w_, h_;
};
