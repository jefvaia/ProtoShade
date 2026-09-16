// ===========================================================================
// THIS IS THE FILE YOU EDIT PER HEAD. Everything head-specific lives here:
// the canvas, the button, the display drivers, where each panel reads from the
// canvas, and what sensors are wired up. protoshade.ino never changes.
// ===========================================================================
//
// It is included exactly once, from the .ino, so these are plain definitions.

#pragma once

#include <Arduino.h>
#include "src/ProtoShadeDisplay.h"

using namespace protoshade;

// ---------------------------------------------------------------------------
// 1. The canvas: the whole face, at the resolution you author at in the editor.
// ---------------------------------------------------------------------------
//
// This is one drawing covering everything the head shows. Panels below cut their own
// rectangles out of it. Canvas area no panel reads is rendered and thrown away - that
// costs time but nothing else, so size this to the face, not to the biggest panel.

constexpr uint16_t CANVAS_W = 128;
constexpr uint16_t CANVAS_H = 32;

// ---------------------------------------------------------------------------
// 2. The upload button
// ---------------------------------------------------------------------------
//
// Held or pressed within UPLOAD_WINDOW_MS of boot, the head starts WiFi and the editor
// instead of the face. After the window it is ignored, so a knock mid-con cannot drop your
// face into an access point.

constexpr int BUTTON_PIN = 0;               // BOOT on most S3 devkits
constexpr bool BUTTON_ACTIVE_LOW = true;    // BOOT shorts to ground
constexpr uint32_t UPLOAD_WINDOW_MS = 60000;
constexpr const char* AP_SSID = "ProtoShade";
constexpr const char* AP_PASSWORD = "protogen";  // 8 characters minimum, or the AP is open

// ---------------------------------------------------------------------------
// 3. Display drivers
// ---------------------------------------------------------------------------
//
// One Display per physical panel. push() gets the pixels already rotated and mirrored for
// that panel, so a driver only has to get them out of the chip.
//
// The one below needs no hardware and no libraries: it prints a frame counter and the
// average colour, which is enough to tell whether the head is rendering what you think.
// Replace it with the real thing - two sketches are below it.
//
// Pins that are already taken on an ESP32-S3-WROOM-1, before you plan a HUB75 harness:
//
//   GPIO 26-32   the module's own SPI flash. Never usable.
//   GPIO 33-37   octal PSRAM, so gone on the R8 parts (N16R8 included) and free on the
//                ones without it. This is the trap: schematics for N16R2 boards use them.
//   GPIO 19, 20  native USB D-/D+, so gone while "USB CDC On Boot" is how you talk to it.
//   GPIO 0       the BOOT button - this sketch uses it to enter upload mode.
//   GPIO 3, 45, 46  strapping pins. Fine as inputs, awkward as outputs at boot.
//
// That leaves 1-2, 4-18, 21, 38-44, 47, 48: enough for HUB75 (13 pins) and sensors.

class SerialDisplay : public Display {
public:
  explicit SerialDisplay(const char* name) : name_(name) {}

  void push(const Pixel* rgb, uint16_t width, uint16_t height) override {
    // Throttled by time, not by frame count: at 200 fps a per-120-frames print is three
    // lines a second, and it would talk over the stats line at a drifting rate.
    if (millis() - last_ < 2000) return;
    last_ = millis();
    uint32_t r = 0, g = 0, b = 0;
    const size_t count = size_t(width) * height;
    for (size_t i = 0; i < count; i++) {
      r += rgb[i].r;
      g += rgb[i].g;
      b += rgb[i].b;
    }
    Serial.printf("%s %ux%u avg #%02lx%02lx%02lx\n", name_, width, height,
                  (unsigned long)(r / count), (unsigned long)(g / count), (unsigned long)(b / count));
  }

private:
  const char* name_;
  uint32_t last_ = 0;
};

// --- HUB75 over I2S DMA ----------------------------------------------------
// Library: ESP32-HUB75-MatrixPanel-I2S-DMA (mrfaptastic). One instance per chain.
//
// #include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
//
// class Hub75Display : public Display {
// public:
//   Hub75Display(uint16_t w, uint16_t h, const HUB75_I2S_CFG::i2s_pins& pins) {
//     HUB75_I2S_CFG cfg(w, h, 1, pins);
//     cfg.double_buff = true;          // so push() never tears against the DMA output
//     matrix_ = new MatrixPanel_I2S_DMA(cfg);
//   }
//   bool begin() override { return matrix_->begin(); }
//   void push(const Pixel* rgb, uint16_t width, uint16_t height) override {
//     for (uint16_t y = 0; y < height; y++)
//       for (uint16_t x = 0; x < width; x++) {
//         const Pixel& p = rgb[size_t(y) * width + x];
//         matrix_->drawPixelRGB888(x, y, p.r, p.g, p.b);
//       }
//     matrix_->flipDMABuffer();
//   }
// private:
//   MatrixPanel_I2S_DMA* matrix_ = nullptr;
// };

// --- WS2812 / addressable strip -------------------------------------------
// Library: FastLED or Adafruit_NeoPixel. Remember these are usually wired in a serpentine,
// which is a per-head detail - do the zigzag here, in push(), not in the shader.
//
// class NeoDisplay : public Display {
//   void push(const Pixel* rgb, uint16_t width, uint16_t height) override {
//     for (uint16_t y = 0; y < height; y++)
//       for (uint16_t x = 0; x < width; x++) {
//         const uint16_t col = (y & 1) ? uint16_t(width - 1 - x) : x;   // serpentine
//         strip_.setPixelColor(y * width + col, ...);
//       }
//     strip_.show();
//   }
// };

SerialDisplay leftEye("left ");
SerialDisplay rightEye("right");

// ---------------------------------------------------------------------------
// 4. The map: which piece of canvas each panel shows
// ---------------------------------------------------------------------------
//
//   src_x, src_y    where on the canvas this panel starts reading
//   width, height   the panel's own resolution, after rotation
//   orient          how it is physically mounted (quarter turns, clockwise)
//   mirror_x/y      flip before rotating
//
// Two panels may read the SAME rectangle. That is how one drawing drives both sides of a
// face: point both at it and set mirror_x on one. A panel mapped past the edge of the
// canvas shows black there rather than garbage.

Panel PANELS[] = {
    // Left half of the canvas, straight through.
    Panel{&leftEye, 0, 0, 64, 32, Orient::Normal, false, false},
    // Right half. Mirror it instead if you want one drawing on both sides:
    //   Panel{&rightEye, 0, 0, 64, 32, Orient::Normal, true, false},
    Panel{&rightEye, 64, 0, 64, 32, Orient::Normal, false, false},
};
constexpr size_t PANEL_COUNT = sizeof(PANELS) / sizeof(PANELS[0]);

// Big enough for the largest panel above. The push task copies one panel at a time through
// it, so it is one panel's worth, not one per panel.
constexpr size_t PANEL_SCRATCH_PIXELS = 64 * 32;

// ---------------------------------------------------------------------------
// 5. Status LED
// ---------------------------------------------------------------------------
//
// The devkit's built-in RGB LED as a mode light, because a head with no panels wired yet
// has nothing else to tell you what it is doing:
//
//   green   rendering your program
//   blue    upload mode, waiting for a .bin
//   red     something is wrong, or nothing is loaded - serial says which
//
// Set STATUS_LED_PIN to -1 if your board has no RGB LED, or once the panels themselves are
// the status light.

#ifdef RGB_BUILTIN
constexpr int STATUS_LED_PIN = RGB_BUILTIN;
#else
constexpr int STATUS_LED_PIN = -1;
#endif
// 0..255. These are blinding at full brightness and this one sits inside a head.
constexpr uint8_t STATUS_LED_BRIGHTNESS = 24;

// How often to print frame timings on serial. 0 is silent.
constexpr uint32_t STATS_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// 6. Sensors
// ---------------------------------------------------------------------------
//
// slot is the index the editor's Sensor node points at. read() returns the value in the
// range that node declares: 0..1 for a flex strip, degrees for a compass, an unbounded
// count for an encoder. Getting from raw ADC counts to that range is this function's job -
// the shader only ever sees the result.
//
// A slot nothing is wired to reads 0, and a slot the program expects but this head does not
// have falls back to the value baked into the .bin, so a half-wired head still renders.

constexpr uint8_t SENSOR_SLOTS = 8;

// Slot 0: boop sensor on GPIO 4, as 0..1.
float readBoop() {
  // return analogRead(4) / 4095.0f;
  return 0.5f + 0.5f * sinf(millis() / 800.0f);  // placeholder so something moves
}

SensorInput SENSORS[] = {
    {0, readBoop},
};
constexpr size_t SENSOR_COUNT = sizeof(SENSORS) / sizeof(SENSORS[0]);
