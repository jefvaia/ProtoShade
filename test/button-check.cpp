// Runs the sketch's button latch on the host.
//
//   part of: node test/check-sketch.mjs   (or: npm test)
//
// The rest of the sketch is only parsed - this one piece is worth executing, because it is
// what stands between a press and upload mode, and because the thing it has to survive is
// exactly what a syntax check cannot show: loop() looking at the button rarely and late.
// Nothing here is a mock of the button; it is the sketch's own code, driven by a clock and a
// pin this file owns.
#include "../protoshade.ino"

#include <cassert>

namespace {
unsigned long now_ms = 0;
bool pin_down = false;
void (*gpio_handler)() = nullptr;  // whatever the sketch attached, if anything

void advance(unsigned long ms) { now_ms += ms; }

// Moves the pin and fires the edge interrupt the GPIO would - only when one is attached, so
// arming and disarming go through the sketch's own code rather than being assumed.
void setButton(bool down) {
  pin_down = down;
  if (gpio_handler) gpio_handler();
}
}  // namespace

// --- the platform, as far as the latch is concerned --------------------------
unsigned long millis() { return now_ms; }
unsigned long micros() { return now_ms * 1000; }
void delay(unsigned long ms) { advance(ms); }
void pinMode(uint8_t, uint8_t) {}
int digitalRead(uint8_t) {
  const bool low = BUTTON_ACTIVE_LOW ? pin_down : !pin_down;
  return low ? LOW : HIGH;
}
void rgbLedWrite(uint8_t, uint8_t, uint8_t, uint8_t) {}
void analogRead(uint8_t) {}
void attachInterrupt(uint8_t, void (*handler)(), int) { gpio_handler = handler; }
void detachInterrupt(uint8_t) { gpio_handler = nullptr; }
SerialStub Serial;
WiFiStub WiFi;

// The rest of the sketch has to link, not to run: the tasks, the panels and the flash all
// belong to the head. Stubbed out here on purpose, so what this file exercises is only the
// latch above it.
namespace protoshade {
bool ParallelRenderer::begin(uint32_t, UBaseType_t) { return true; }
void ParallelRenderer::end() {}
bool ParallelRenderer::render(const ProtoShadeRuntime&, const Frame&, Pixel*) { return true; }
bool PanelPusher::begin(const Panel*, size_t, uint16_t, uint16_t, Pixel*, BaseType_t, uint32_t, UBaseType_t) {
  return true;
}
void PanelPusher::submit(const Pixel*) {}
void PanelPusher::wait() {}
}  // namespace protoshade

namespace upload {
bool loadProgramFromFlash(ProtoShadeRuntime&) { return false; }
bool begin(ProtoShadeRuntime&, const char*, const char*) { return true; }
void handle() {}
bool lastUploadFailed() { return false; }
}  // namespace upload

int main() {
  armButton();  // what setup() does once the pin is configured

  // Nothing has happened yet.
  assert(!buttonPressed());

  // Contact bounce: too short to be a press, and it must not leave anything behind.
  now_ms = 1000;
  setButton(true);
  advance(kButtonHoldMs - 10);
  setButton(false);
  assert(!buttonPressed());
  assert(!buttonPressed());

  // A real press that started AND finished between two frames. This is the case that made
  // the button feel dead: a slow frame means nobody was looking while it happened.
  setButton(true);
  advance(kButtonHoldMs + 30);
  setButton(false);
  advance(30000);  // ... and half a minute of blocked frames before anyone asks
  assert(buttonPressed());
  assert(!buttonPressed());  // consumed once, not once per frame from here on

  // Still being held when loop() finally looks: also a press, without waiting for release.
  setButton(true);
  advance(kButtonHoldMs);
  assert(buttonPressed());
  setButton(false);
  assert(buttonPressed());  // the release completes a press long enough to count
  assert(!buttonPressed());

  // Disarmed: the window is shut, or flash is about to be erased under the handler.
  disarmButton();
  setButton(true);
  advance(kButtonHoldMs * 4);
  setButton(false);
  assert(!buttonPressed());

  printf("button-check: ok\n");
  return 0;
}
