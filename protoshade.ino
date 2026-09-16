// A protogen head, end to end.
//
// Boot -> the face starts rendering immediately. For the first 60 seconds the button is
// armed: press it and the head switches to UPLOAD MODE - WiFi, the editor, and the page
// that writes a new .bin into flash. Leave it alone and it just runs the face; after the
// window the button is ignored, so a knock mid-con cannot drop your face into an AP.
//
// The face is deliberately not blanked for that minute. Waiting 60 seconds with a dark
// visor to find out whether anyone wants to flash it is the wrong trade; if you do want a
// hard wait, put the loop in setup() instead - see enterUploadMode().
//
// Everything head-specific - canvas size, panels, drivers, sensors - is in head_config.h.
// This file is the same on every head.
//
// Nothing to install: this file sits at the root of the repository, so the repository IS the
// sketch folder, and src/ is the sketch's own src/ - which the Arduino builder compiles
// recursively. Open the folder, hit Verify.
//
// Set Tools > Partition Scheme > Custom: the .bin lives in its own flash partition (see
// partitions.csv), so it survives power loss and costs no RAM - esp_partition_mmap maps it
// into the address space and the runtime reads the images straight out of it.

#include <WiFi.h>

#include "src/ProtoShadeParallel.h"
#include "src/ProtoShadeRuntime.h"

#include "head_config.h"
#include "upload_mode.h"

using namespace protoshade;

ProtoShadeRuntime runtime;
ParallelRenderer renderer;  // renders the frame across both cores
PanelPusher pusher;         // sends the finished frame to the panels from a third task

// Two canvases. One is being pushed to the panels while the next is rendered into the
// other, which is the whole reason the pusher exists - see PanelPusher for the protocol.
Pixel canvasA[size_t(CANVAS_W) * CANVAS_H];
Pixel canvasB[size_t(CANVAS_W) * CANVAS_H];
Pixel panelScratch[PANEL_SCRATCH_PIXELS];
Pixel* back = canvasA;
Pixel* front = canvasB;

float sensorValues[SENSOR_SLOTS];

enum class Mode : uint8_t { Face, Upload };
Mode mode = Mode::Face;

// ---------------------------------------------------------------------------
// Status LED
// ---------------------------------------------------------------------------

// LedState, not Status: the sketch says `using namespace protoshade;` and the runtime
// already has a Status (the load-status enum), so that name is ambiguous here.
enum class LedState : uint8_t { Running, Upload, Error };

// Latched: something is structurally wrong and will not fix itself - a driver that did not
// start, no partition to load from. A heavy frame or a missing program is NOT latched, so
// the light goes back to green on its own when it recovers.
bool fault = false;

void fail(const char* why) {
  Serial.printf("error: %s\n", why);
  fault = true;
}

// Only writes when the colour actually changes: this runs every frame, and rgbLedWrite bangs
// out an RMT sequence each time it is called.
void setLed(LedState state) {
  static LedState shown = LedState::Running;
  static bool written = false;
  if (written && state == shown) return;
  shown = state;
  written = true;
  if (STATUS_LED_PIN < 0) return;

  const uint8_t b = STATUS_LED_BRIGHTNESS;
  switch (state) {
    case LedState::Running: rgbLedWrite(STATUS_LED_PIN, 0, b, 0); break;
    case LedState::Upload:  rgbLedWrite(STATUS_LED_PIN, 0, 0, b); break;
    case LedState::Error:   rgbLedWrite(STATUS_LED_PIN, b, 0, 0); break;
  }
}

// ---------------------------------------------------------------------------

bool buttonDown() {
  const int level = digitalRead(BUTTON_PIN);
  return BUTTON_ACTIVE_LOW ? level == LOW : level == HIGH;
}

// Debounce by simply requiring it to stay down. A face that flips into upload mode because
// of a contact bounce is worse than one that needs the button held for a moment.
bool buttonHeld(uint32_t ms) {
  if (!buttonDown()) return false;
  const uint32_t started = millis();
  while (millis() - started < ms) {
    if (!buttonDown()) {
      // Worth saying out loud: "I pressed it and nothing happened" and "the pin never went
      // low" are different problems, and this is the line that tells them apart.
      Serial.println("button: saw a press but it was released too early - hold it a moment");
      return false;
    }
    delay(5);
  }
  return true;
}

// Typing u on the serial monitor does the same thing, window or not. A button is one wire
// and one pin number away from not working; this path has neither, so it is also the answer
// for a head that has no button on it yet.
bool uploadRequestedOverSerial() {
  bool asked = false;
  while (Serial.available() > 0) {
    const int c = Serial.read();
    if (c == 'u' || c == 'U') asked = true;
  }
  return asked;
}

void swapCanvases() {
  Pixel* t = back;
  back = front;
  front = t;
}

// ---------------------------------------------------------------------------
// Program mode: the actual face
// ---------------------------------------------------------------------------

// Frame timing, split into the two things that can be the bottleneck. If render is the big
// number the shader is too heavy for this resolution; if panels is, the display driver is
// holding the frame up and the extra push task is already earning its keep.
struct Stats {
  uint32_t frames = 0;
  uint32_t render_us = 0;  // inside renderer.render(), both cores
  uint32_t wait_us = 0;    // blocked in submit(), i.e. waiting for the previous push
  uint32_t since = 0;
} stats;

float fps = 0.0f;  // last measured, also what reportStats prints

void reportStats() {
  const uint32_t now = millis();
  const uint32_t elapsed = now - stats.since;
  if (STATS_INTERVAL_MS == 0 || elapsed < STATS_INTERVAL_MS || stats.frames == 0) return;

  fps = float(stats.frames) * 1000.0f / float(elapsed);
  Serial.printf("stats: %.1f fps  render %.2f ms  panels %.2f ms\n", double(fps),
                double(stats.render_us) / 1000.0 / stats.frames,
                double(stats.wait_us) / 1000.0 / stats.frames);
  stats = Stats{};
  stats.since = now;
}

void renderFace() {
  readSensors(SENSORS, SENSOR_COUNT, sensorValues, SENSOR_SLOTS);

  // One snapshot per frame, shared by both render tasks. A reading that changed halfway
  // through would put a different value in the top half of the face than the bottom.
  const Sensors sensors{sensorValues, SENSOR_SLOTS};
  const Frame frame = runtime.beginFrame(millis(), sensors);

  const uint32_t started = micros();
  const bool within_budget = renderer.render(runtime, frame, back);
  const uint32_t rendered = micros();
  if (!within_budget) {
    Serial.println("step budget exceeded - the shader is too heavy for this frame rate");
  }

  // Green means it is rendering YOUR program. A head with nothing uploaded is running the
  // built-in test pattern, which is not the same thing and is worth a red light.
  setLed(fault || !within_budget || !runtime.hasProgram() ? LedState::Error : LedState::Running);

  // Hands the frame to the push task and returns; it blocks only until the PREVIOUS push is
  // done, so rendering the next frame overlaps sending this one.
  pusher.submit(back);
  swapCanvases();

  // micros() wraps every ~71 minutes; unsigned subtraction wraps with it and stays right.
  stats.render_us += rendered - started;
  stats.wait_us += micros() - rendered;
  stats.frames++;
  reportStats();
}

// ---------------------------------------------------------------------------
// Upload mode
// ---------------------------------------------------------------------------

void enterUploadMode() {
  Serial.println("switching to upload mode: the face stops, WiFi comes up");
  mode = Mode::Upload;

  // Stop rendering before the flash partition can be erased under us, and give the two
  // render tasks' stacks back to the heap - WiFi and the web server want them more.
  pusher.wait();
  renderer.end();

  if (!upload::begin(runtime, AP_SSID, AP_PASSWORD)) {
    fail("upload mode failed to start");
  }
}

// A slow blue pulse across every panel, so you can see from the other side of the room that
// the head is waiting for a file rather than rendering a face. The VM is deliberately not
// running here: upload mode erases the bytes it would be reading.
void showUploadIndicator() {
  const uint8_t v = uint8_t(40.0f + 60.0f * (0.5f + 0.5f * sinf(millis() / 500.0f)));
  for (size_t i = 0; i < size_t(CANVAS_W) * CANVAS_H; i++) back[i] = Pixel{0, uint8_t(v / 3), v};
  pusher.submit(back);
  swapCanvases();
}

// ---------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(200);

  // Red until setup finishes: if it hangs or crashes on the way, the light says so instead
  // of staying dark and looking like a dead board.
  setLed(LedState::Error);

  pinMode(BUTTON_PIN, BUTTON_ACTIVE_LOW ? INPUT_PULLUP : INPUT_PULLDOWN);
  delay(10);  // let the pull settle before reading it
  // Reads PRESSED with nothing touched means the pin or the polarity is wrong, and that is
  // worth knowing at boot rather than after a minute of pressing a button that does nothing.
  Serial.printf("button: GPIO %d reads %s at boot%s\n", BUTTON_PIN,
                buttonDown() ? "PRESSED" : "released",
                buttonDown() ? "  <-- wrong pin, or BUTTON_ACTIVE_LOW is inverted" : "");

  for (size_t i = 0; i < PANEL_COUNT; i++) {
    if (PANELS[i].display && !PANELS[i].display->begin()) {
      Serial.printf("display %u failed to start\n", unsigned(i));
      fault = true;
    }
  }

  runtime.setResolution(CANVAS_W, CANVAS_H);
  if (!upload::loadProgramFromFlash(runtime)) {
    // Not fatal: the head renders its test pattern and waits for you to upload something.
    Serial.println("no program loaded - the light stays red until one is");
  }

  // Nothing needs the radio to render a face, and it costs power and core 0 time.
  WiFi.mode(WIFI_OFF);

  if (!renderer.begin()) fail("renderer.begin() failed - out of memory?");
  if (!pusher.begin(PANELS, PANEL_COUNT, CANVAS_W, CANVAS_H, panelScratch)) {
    fail("pusher.begin() failed - out of memory?");
  }

  stats.since = millis();
  Serial.printf("face running at %ux%u. Press the button within %lu s for upload mode, or\n"
                "type u here at any time.\n",
                CANVAS_W, CANVAS_H, (unsigned long)(UPLOAD_WINDOW_MS / 1000));
}

void loop() {
  if (mode == Mode::Upload) {
    upload::handle();
    // Blue while it waits; red if the last .bin was refused, so you can see a bad upload
    // without going back to the browser tab.
    setLed(fault || upload::lastUploadFailed() ? LedState::Error : LedState::Upload);
    showUploadIndicator();
    delay(10);
    return;
  }

  if (uploadRequestedOverSerial()) {
    enterUploadMode();
    return;
  }

  // The window is measured from boot. Past it the button does nothing at all, which is the
  // point - but say so once, or a press at 61 seconds looks like a broken button.
  static bool window_closed = false;
  if (millis() < UPLOAD_WINDOW_MS) {
    if (buttonHeld(50)) {
      enterUploadMode();
      return;
    }
  } else if (!window_closed) {
    window_closed = true;
    Serial.println("upload window closed - power-cycle for the button, or type u here");
  }

  renderFace();
}
