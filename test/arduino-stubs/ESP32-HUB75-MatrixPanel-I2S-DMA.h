#pragma once
// Just enough of mrfaptastic's HUB75 DMA library for head_config.h to parse. Nothing runs.
#include <stdint.h>

struct HUB75_I2S_CFG {
  struct i2s_pins {
    int8_t r1, g1, b1, r2, g2, b2, a, b, c, d, e, lat, oe, clk;
  } gpio;
  bool double_buff = false;
  bool clkphase = true;
  uint8_t latch_blanking = 1;
  HUB75_I2S_CFG(uint16_t, uint16_t, uint16_t, i2s_pins p) : gpio(p) {}
};

class MatrixPanel_I2S_DMA {
public:
  explicit MatrixPanel_I2S_DMA(const HUB75_I2S_CFG&) {}
  bool begin() { return true; }
  void setBrightness8(uint8_t) {}
  void drawPixelRGB888(int16_t, int16_t, uint8_t, uint8_t, uint8_t) {}
  void flipDMABuffer() {}
};
