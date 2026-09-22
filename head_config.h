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
//
// Both sides, not one: the default map below puts the second panel at x = 64, so a 64 wide
// canvas would have it reading past the edge and showing black. One 64x32 side of a face is
// a panel; the face is the two of them.

constexpr uint16_t CANVAS_W = 128;  // two 64x32 panels side by side
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

// Coming back OUT of upload mode. The face stops while the head is an access point - the VM
// renders straight out of the partition an upload erases - so these say when it starts again
// without anyone having to reach for the power.
//
//   UPLOAD_RETURN_MS  after a .bin has landed and loaded. The wait is so the browser gets
//                     its answer before the access point disappears under it.
//   UPLOAD_IDLE_MS    with nothing asked of the web server at all. A head that went into
//                     upload mode by accident puts its face back on by itself.
//
// 0 disables either one. Whatever these say, the button and `u` on the serial monitor bring
// the face back at any time, and flashing over USB does too.
constexpr uint32_t UPLOAD_RETURN_MS = 2000;
constexpr uint32_t UPLOAD_IDLE_MS = 5 * 60 * 1000;

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
// Library: "ESP32 HUB75 LED MATRIX PANEL DMA Display" by mrfaptastic, from the Library
// Manager (say yes to Adafruit GFX when it asks).
//
// Both panels hang off ONE ribbon chain: ESP32 -> panel 1 IN, panel 1 OUT -> panel 2 IN.
// To the library that is one 128x32 matrix, so there is one Hub75Chain and each panel is a
// window into it at its own x offset. Keeping them as two Displays is what lets the map
// below mirror or rotate each panel on its own.

#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>

// Pins for an ESP32-S3-WROOM-1 N16R8, clear of flash, PSRAM, USB and strapping pins.
// Order is the library's: r1 g1 b1 r2 g2 b2 a b c d e lat oe clk. E is -1: a 64x32
// panel is 1/16 scan and has no E line.
const HUB75_I2S_CFG::i2s_pins HUB75_PINS = {4, 5, 6, 7, 15, 16, 18, 8, 17, 12, -1, 10, 11, 9};

// 0..255. Caps the current before it reaches the power bank: two panels at full white and
// full brightness is ~8 A, well past what it can hold. Raise it once the visor is on and
// you have measured the draw.
constexpr uint8_t PANEL_BRIGHTNESS = 64;

class Hub75Chain {
public:
  Hub75Chain(uint16_t panel_w, uint16_t panel_h, uint16_t panels) {
    HUB75_I2S_CFG cfg(panel_w, panel_h, panels, HUB75_PINS);
    cfg.double_buff = true;  // so a push never tears against the DMA output
    // Both found on the bench with these panels on loose jumper wires:
    cfg.clkphase = false;    // pixels in a moving line landed one column late without it
    cfg.latch_blanking = 2;  // faint afterglow where a line had just been
    matrix_ = new MatrixPanel_I2S_DMA(cfg);
  }
  // Every panel calls this; only the first actually starts the chain.
  bool begin() {
    if (!started_) {
      started_ = matrix_->begin();
      if (started_) matrix_->setBrightness8(PANEL_BRIGHTNESS);
    }
    return started_;
  }
  MatrixPanel_I2S_DMA& matrix() { return *matrix_; }

private:
  MatrixPanel_I2S_DMA* matrix_ = nullptr;
  bool started_ = false;
};

class Hub75Panel : public Display {
public:
  // flips: set on the panel pushed LAST (the last one in PANELS), so the whole chain
  // swaps buffers once, with both panels drawn.
  Hub75Panel(Hub75Chain& chain, uint16_t x_offset, bool flips)
      : chain_(chain), x_(x_offset), flips_(flips) {}
  bool begin() override { return chain_.begin(); }
  void push(const Pixel* rgb, uint16_t width, uint16_t height) override {
    MatrixPanel_I2S_DMA& m = chain_.matrix();
    for (uint16_t y = 0; y < height; y++)
      for (uint16_t x = 0; x < width; x++) {
        const Pixel& p = rgb[size_t(y) * width + x];
        m.drawPixelRGB888(int16_t(x_ + x), int16_t(y), p.r, p.g, p.b);
      }
    if (flips_) m.flipDMABuffer();
  }

private:
  Hub75Chain& chain_;
  uint16_t x_;
  bool flips_;
};

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

Hub75Chain chain(64, 32, 2);
// If the two sides come out swapped, swap these two x offsets (0 and 64).
Hub75Panel leftEye(chain, 0, false);
Hub75Panel rightEye(chain, 64, true);

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

// Mirroring the canvas to the editor over USB (type p on the serial monitor, or press
// "mirror head" in the editor). One frame is CANVAS_W * CANVAS_H * 3 bytes, so this is
// throttled rather than sent every frame - the point is to watch the head, not to keep up
// with it. 0 streams as fast as the port drains, which will slow the face down.
constexpr uint32_t STREAM_INTERVAL_MS = 50;

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

// Slot 0: boop sensor, as 0..1. GPIO 4 is R1 now; the planned VCNL4040 goes on I2C
// (SDA 1, SCL 2) instead.
float readBoop() {
  return 0.5f + 0.5f * sinf(millis() / 800.0f);  // placeholder so something moves
}

SensorInput SENSORS[] = {
    {0, readBoop},
};
constexpr size_t SENSOR_COUNT = sizeof(SENSORS) / sizeof(SENSORS[0]);
