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
    if (!buttonDown()) return false;
    delay(5);
  }
  return true;
}

void swapCanvases() {
  Pixel* t = back;
  back = front;
  front = t;
}

// ---------------------------------------------------------------------------
// Program mode: the actual face
// ---------------------------------------------------------------------------

void renderFace() {
  readSensors(SENSORS, SENSOR_COUNT, sensorValues, SENSOR_SLOTS);

  // One snapshot per frame, shared by both render tasks. A reading that changed halfway
  // through would put a different value in the top half of the face than the bottom.
  const Sensors sensors{sensorValues, SENSOR_SLOTS};
  const Frame frame = runtime.beginFrame(millis(), sensors);

  if (!renderer.render(runtime, frame, back)) {
    Serial.println("step budget exceeded - the shader is too heavy for this frame rate");
  }

  // Hands the frame to the push task and returns; it blocks only until the PREVIOUS push is
  // done, so rendering the next frame overlaps sending this one.
  pusher.submit(back);
  swapCanvases();
}

// ---------------------------------------------------------------------------
// Upload mode
// ---------------------------------------------------------------------------

void enterUploadMode() {
  Serial.println("button pressed - switching to upload mode");
  mode = Mode::Upload;

  // Stop rendering before the flash partition can be erased under us, and give the two
  // render tasks' stacks back to the heap - WiFi and the web server want them more.
  pusher.wait();
  renderer.end();

  if (!upload::begin(runtime, AP_SSID, AP_PASSWORD)) {
    Serial.println("upload mode failed to start");
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

  pinMode(BUTTON_PIN, BUTTON_ACTIVE_LOW ? INPUT_PULLUP : INPUT_PULLDOWN);

  for (size_t i = 0; i < PANEL_COUNT; i++) {
    if (PANELS[i].display && !PANELS[i].display->begin()) {
      Serial.printf("display %u failed to start\n", unsigned(i));
    }
  }

  runtime.setResolution(CANVAS_W, CANVAS_H);
  upload::loadProgramFromFlash(runtime);

  // Nothing needs the radio to render a face, and it costs power and core 0 time.
  WiFi.mode(WIFI_OFF);

  if (!renderer.begin()) Serial.println("renderer.begin() failed - out of memory?");
  if (!pusher.begin(PANELS, PANEL_COUNT, CANVAS_W, CANVAS_H, panelScratch)) {
    Serial.println("pusher.begin() failed - out of memory?");
  }

  Serial.printf("face running at %ux%u. Press the button within %lu s for upload mode.\n",
                CANVAS_W, CANVAS_H, (unsigned long)(UPLOAD_WINDOW_MS / 1000));
}

void loop() {
  if (mode == Mode::Upload) {
    upload::handle();
    showUploadIndicator();
    delay(10);
    return;
  }

  // The window is measured from boot. Past it, the button does nothing at all.
  if (millis() < UPLOAD_WINDOW_MS && buttonHeld(50)) {
    enterUploadMode();
    return;
  }

  renderFace();
}
