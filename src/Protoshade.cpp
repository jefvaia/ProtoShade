#include "Protoshade.h"

uint8_t Protoshade::pixel(uint16_t x, uint16_t y, uint32_t ms) const {
  uint32_t phase = (uint32_t(x) + y) * 16 + ms / 4;
  uint8_t p = phase & 0xFF;                  // 0..255 sawtooth
  return p < 128 ? p * 2 : (255 - p) * 2;    // fold into triangle wave
}
