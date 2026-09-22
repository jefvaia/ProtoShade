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

// What the serial port was asked for, read by serialRequest() far below.
//
// It lives up HERE, above the first function in the file, because the Arduino builder runs
// ctags over the .ino and inserts a generated prototype for every function immediately
// before the first function definition. `Request serialRequest();` therefore appears near
// the top of the file whatever we do, and a type it names has to already exist at that
// point - declare this next to serialRequest() and the IDE says "'Request' does not name a
// type" while every other compiler in this repository is perfectly happy. Same reason Mode
// and LedState are up here. test/check-sketch.mjs does the same hoisting, so a type that
// slips back down the file fails there instead of on somebody's board.
enum class Request : uint8_t { None, UploadMode, Flash };

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

// Forward declaration: setLed is defined below but setup() and the fault paths both want it.
void setLed(LedState state, const char* why = "");

// Only writes when the colour actually changes: this runs every frame, and rgbLedWrite bangs
// out an RMT sequence each time it is called.
//
// It also says why, once, on the change. A red light with no explanation is a light that
// tells you something is wrong and nothing else, and "it is red no matter what I do" is
// then a question only the source code can answer.
void setLed(LedState state, const char* why) {
  static LedState shown = LedState::Running;
  static bool written = false;
  if (written && state == shown) return;
  shown = state;
  written = true;

  const char* name = state == LedState::Running ? "green" : state == LedState::Upload ? "blue" : "RED";
  Serial.printf("led: %s%s%s\n", name, why[0] ? " - " : "", why);
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

// The pin latches its own presses, because loop() is not a reliable place to look for one.
// A frame ends in pusher.submit(), which blocks until the previous push is done, and a push
// runs whatever Display::push() a head puts in head_config.h - the built-in SerialDisplay
// writes to a USB port that blocks when nobody is draining it, a panel driver can wait on a
// bus. Sample the pin once per frame and a press that starts and ends between two slow
// frames never happened: you press the button, nothing takes, and the pin was never wrong.
//
// So an edge interrupt times the press and loop() reads the result whenever it gets round
// to it, however long that is.
constexpr uint32_t kButtonHoldMs = 50;
volatile uint32_t button_down_at = 0;   // millis() when the current press started, 0 if up
volatile uint32_t button_press_ms = 0;  // how long the last finished press lasted
volatile uint32_t button_edges = 0;     // every edge ever seen, for the noise guard below

// IRAM_ATTR because this can fire while the flash cache is off. digitalRead() is not itself
// IRAM-safe, which is why the interrupt is detached before upload mode erases anything.
void IRAM_ATTR onButtonEdge() {
  const uint32_t now = millis();
  button_edges++;
  if (buttonDown()) {
    button_down_at = now;
  } else if (button_down_at != 0) {
    button_press_ms = now - button_down_at;
    button_down_at = 0;
  }
}

void armButton() {
  attachInterrupt(digitalPinToInterrupt(BUTTON_PIN), onButtonEdge, CHANGE);
}

// Nothing may latch a press once the window is shut, and nothing may run this handler while
// the flash cache is off - upload mode erases the program partition.
void disarmButton() {
  detachInterrupt(digitalPinToInterrupt(BUTTON_PIN));
  button_down_at = 0;
  button_press_ms = 0;
}

// A press long enough to be a press: one that has finished, or one still being held. Short
// ones are contact bounce and are said out loud rather than acted on - "I pressed it and
// nothing happened" and "the pin never moved" are different problems.
bool buttonPressed() {
  const uint32_t finished = button_press_ms;
  if (finished != 0) {
    button_press_ms = 0;
    if (finished >= kButtonHoldMs) return true;
    // Once a second at most. This runs inside the frame loop, and a line on a USB port that
    // nobody is draining blocks until the driver gives up on it - so a pin that bounces
    // every frame turns a diagnostic into the slowest thing in the render loop. The message
    // is for a person pressing a button too briefly; it does not need to be every time.
    static uint32_t complained_at = 0;
    const uint32_t now = millis();
    if (now - complained_at >= 1000) {
      complained_at = now;
      Serial.printf("button: a %lu ms press is too short - hold it a moment\n",
                    (unsigned long)finished);
    }
  }
  const uint32_t started = button_down_at;
  return started != 0 && millis() - started >= kButtonHoldMs;
}

// Edges no finger produced.
//
// A button pin is one long wire in a head full of them, and a HUB75 harness clocks tens of
// megahertz right next to it. A pin picking that up fires edges continuously, and every one
// of them is an interrupt on a core that is trying to render a face: the frame rate falls
// through the floor until the upload window closes and the pin is let go of, which is a
// minute of a head that looks broken and then fixes itself. Nothing in the log says why.
//
// So: count the edges, and past a rate a thumb cannot produce, let the pin go early and say
// so. The upload button stops working for the rest of that boot - it was never going to
// work, it was only going to cost frames - and `u` on the serial monitor and flashing over
// USB are both still there.
//
// ponytail: a plain rate check, once a second, no filtering. If a head ever has a button
// that genuinely chatters this hard and still has to work, the upgrade is a Schmitt input or
// an RC on the pin, not a cleverer count.
constexpr uint32_t kButtonNoiseEdgesPerSecond = 200;

bool buttonNoisy() {
  static uint32_t since = 0;
  static uint32_t seen = 0;
  const uint32_t now = millis();
  if (since == 0) since = now;
  if (now - since < 1000) return false;
  const uint32_t edges = button_edges - seen;
  seen = button_edges;
  since = now;
  if (edges <= kButtonNoiseEdgesPerSecond) return false;
  Serial.printf("button: GPIO %d fired %lu edges in a second - that is not a press, it is\n"
                "pickup from the panel harness. Letting the pin go; type u here for upload\n"
                "mode, or flash over USB from the editor.\n",
                BUTTON_PIN, (unsigned long)edges);
  return true;
}

// Upload mode detaches the interrupt above - it cannot be allowed to run while an erase has
// the flash cache down - so a press in upload mode is polled instead. loop() is idle enough
// there for that to be reliable, which it is not while frames are being pushed.
//
// The pin has to be seen RELEASED first, or the press that opened upload mode is also the
// one that closes it half a second later.
bool button_was_released = false;
uint32_t button_held_since = 0;

void resetButtonPoll() {
  button_was_released = false;
  button_held_since = 0;
}

bool buttonPolled() {
  if (!buttonDown()) {
    button_was_released = true;
    button_held_since = 0;
    return false;
  }
  if (!button_was_released) return false;
  if (button_held_since == 0) button_held_since = millis();
  return millis() - button_held_since >= kButtonHoldMs;
}

// Mirrors the canvas to whoever is on the other end of the USB cable. The editor picks the
// frames out of the log stream and draws them, so you can watch what the head is actually
// rendering while it is on your head.
//
// Blocking on purpose: Serial.write() returns when the host has taken the bytes, which is
// the backpressure that keeps this from flooding a port nobody is reading. The throttle
// above is what keeps it from being the thing that sets your frame rate.
bool streaming = false;
uint32_t streamed_at = 0;

void streamFrame(const Pixel* canvas) {
  static_assert(sizeof(Pixel) == 3, "the stream is tightly packed RGB");
  if (!streaming) return;
  if (STREAM_INTERVAL_MS != 0 && millis() - streamed_at < STREAM_INTERVAL_MS) return;
  streamed_at = millis();

  const uint8_t header[10] = {
      'P', 'S', 'F', 'R',
      uint8_t(CANVAS_W & 0xFF), uint8_t(CANVAS_W >> 8),
      uint8_t(CANVAS_H & 0xFF), uint8_t(CANVAS_H >> 8),
      0,  // format: packed RGB888
      0,  // flags
  };
  Serial.write(header, sizeof(header));
  Serial.write(reinterpret_cast<const uint8_t*>(canvas), size_t(CANVAS_W) * CANVAS_H * 3);
}

// Typing u on the serial monitor does the same thing, window or not. A button is one wire
// and one pin number away from not working; this path has neither, so it is also the answer
// for a head that has no button on it yet. (Request itself is declared at the top of the
// file - see the comment there for why it cannot live next to the function that returns it.)
//
// 0x02 rather than a letter: this port is shared with a person typing at a serial monitor,
// and every printable character is either a command already or one someone might send by
// accident. Nothing else is read here - the rest of the handshake belongs to
// upload::receiveOverSerial(), and is still sitting in the receive buffer for it.
constexpr uint8_t kFlashRequest = 0x02;

// Room for a whole flash chunk and then some. See setup() for why this is not optional.
constexpr size_t kSerialRxBuffer = 4096;

Request serialRequest() {
  Request asked = Request::None;
  while (Serial.available() > 0) {
    const int c = Serial.read();
    if (c == kFlashRequest) return Request::Flash;
    if (c == 'u' || c == 'U') asked = Request::UploadMode;
    if (c == 'p' || c == 'P') {
      streaming = !streaming;
      Serial.printf("pixel stream %s\n", streaming ? "on" : "off");
    }
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
  // Each half on its own. The split is a fixed 50/50, but core 0 also carries loop(), the
  // serial port and the push task, so the two are not the same job. A frame costs whatever
  // the slower half costs, and the gap between these two is what an uneven split would buy.
  uint32_t half_us[2] = {0, 0};
  uint32_t since = 0;
} stats;

float fps = 0.0f;  // last measured, also what reportStats prints

// Everything that decides what you see, printed once at boot. A panel mapped outside the
// canvas is silently black and a canvas far bigger than you meant is silently slow; both
// look like "the head is broken" and neither says so on its own.
void reportConfig() {
  const uint32_t pixels = uint32_t(CANVAS_W) * CANVAS_H;
  Serial.printf("canvas %ux%u = %lu pixels\n", CANVAS_W, CANVAS_H, (unsigned long)pixels);
  Serial.printf("runtime %ux%u, program: ", runtime.width(), runtime.height());
  if (runtime.hasProgram()) {
    // The per-pixel count is the one that decides the frame rate. Anything driven only by
    // time or a sensor is the same for every pixel and runs once a frame instead.
    Serial.printf("%u instructions (%u once a frame, %u per pixel), %u images, %u sensor slots\n",
                  runtime.instructionCount(), runtime.uniformInstructions(),
                  runtime.pixelInstructions(), runtime.assetCount(), runtime.sensorCount());
  } else {
    Serial.printf("none (status %d) - showing the built-in test pattern\n", int(runtime.status()));
  }

  for (size_t i = 0; i < PANEL_COUNT; i++) {
    const Panel& p = PANELS[i];
    const uint32_t x1 = uint32_t(p.src_x) + p.sourceWidth();
    const uint32_t y1 = uint32_t(p.src_y) + p.sourceHeight();
    const bool inside = x1 <= CANVAS_W && y1 <= CANVAS_H;
    Serial.printf("panel %u: %ux%u reads canvas (%u,%u)-(%lu,%lu)%s\n", unsigned(i), p.width,
                  p.height, p.src_x, p.src_y, (unsigned long)x1, (unsigned long)y1,
                  inside ? "" : "   <-- OUTSIDE THE CANVAS, this panel renders black");
    // Warned about, not latched. A panel mapped past the edge is a mistake in
    // head_config.h, but the head is still rendering everything else exactly as asked -
    // and a red light that cannot be cleared says "broken" about a head that works.
    // The line above is the signal; it prints on every boot.
  }
}

void reportStats() {
  const uint32_t now = millis();
  const uint32_t elapsed = now - stats.since;
  if (STATS_INTERVAL_MS == 0 || elapsed < STATS_INTERVAL_MS || stats.frames == 0) return;

  fps = float(stats.frames) * 1000.0f / float(elapsed);
  const double render_us = double(stats.render_us) / stats.frames;
  // Per pixel as well as per frame: a slow frame is either a heavy shader or too many
  // pixels, and the two numbers together say which without any guessing.
  Serial.printf(
      "stats: %.1f fps  render %.2f ms (%.3f us/px)  halves %.2f / %.2f ms  panels %.2f ms\n",
      double(fps), render_us / 1000.0, render_us / double(uint32_t(CANVAS_W) * CANVAS_H),
      double(stats.half_us[0]) / 1000.0 / stats.frames,
      double(stats.half_us[1]) / 1000.0 / stats.frames,
      double(stats.wait_us) / 1000.0 / stats.frames);
  stats = Stats{};
  stats.since = now;
}

void renderFace() {
  readSensors(SENSORS, SENSOR_COUNT, sensorValues, SENSOR_SLOTS);
  // The LED is red from setup() until the first frame is on the panels, so this is the line
  // that says how long that was - and whether a long red light was the boot or the frame.
  static bool first_frame = true;

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
  if (fault) {
    setLed(LedState::Error, "a fault was latched at boot - look further up this log");
  } else if (!runtime.hasProgram()) {
    setLed(LedState::Error, "no program in flash - upload a .bin, this is the test pattern");
  } else if (!within_budget) {
    setLed(LedState::Error, "step budget exceeded - the shader is too heavy");
  } else {
    setLed(LedState::Running, "rendering your program");
  }

  if (first_frame) {
    first_frame = false;
    Serial.printf("first frame at %lu ms (render %lu us) - the light stops being red here\n",
                  (unsigned long)millis(), (unsigned long)(rendered - started));
  }

  // Hands the frame to the push task and returns; it blocks only until the PREVIOUS push is
  // done, so rendering the next frame overlaps sending this one.
  pusher.submit(back);
  // Before the swap: `back` is the frame that was just rendered. The push task is reading
  // it too, and two readers of the same pixels get along fine.
  streamFrame(back);
  swapCanvases();

  // micros() wraps every ~71 minutes; unsigned subtraction wraps with it and stays right.
  stats.render_us += rendered - started;
  stats.half_us[0] += renderer.halfMicros(0);
  stats.half_us[1] += renderer.halfMicros(1);
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
  disarmButton();  // its job is done, and erasing flash turns the cache off under the handler

  // Stop rendering before the flash partition can be erased under us, and give the two
  // render tasks' stacks back to the heap - WiFi and the web server want them more.
  pusher.wait();
  renderer.end();

  resetButtonPoll();
  if (!upload::begin(runtime, AP_SSID, AP_PASSWORD)) {
    fail("upload mode failed to start");
  }
}

// And back again. Upload mode used to be a one-way door: the only way out of an access point
// was the power switch, which is a poor thing to reach for with a head on.
//
// Order matters. WiFi and the web server go first, because the reason the renderer was
// stopped on the way in was to give them its stacks - start the render tasks before letting
// go of that and begin() fails on a heap that is still full.
void leaveUploadMode(const char* why) {
  Serial.printf("leaving upload mode (%s): WiFi goes down, the face comes back\n", why);
  upload::end();

  // Whatever is in the partition now, mapped again. After an upload this is the new program;
  // after an idle timeout it is the same one as before, and either way the runtime must hold
  // a live mapping before a render task reads a pixel out of it.
  if (!upload::loadProgramFromFlash(runtime)) {
    Serial.println("nothing valid in the partition - the face is the test pattern");
  }
  if (!renderer.begin()) {
    fail("renderer.begin() failed coming out of upload mode - out of memory?");
    return;
  }

  mode = Mode::Face;
  // The button is not re-armed: the window it belonged to is long shut, and an interrupt
  // that fires during the next erase is exactly what disarming it was for.
  stats = Stats{};
  stats.since = millis();
}

// Flashing over USB, which is upload mode's job without any of upload mode: no WiFi, no
// access point, no browser, and the face is back a second later. The editor drives it over
// the cable it already uses to mirror the head.
bool flashOverSerial() {
  Serial.println("flashing over USB: the face pauses while flash is written");
  // Both for the same reason: erasing flash takes the cache down with it, and neither the
  // VM nor an interrupt handler may be reading out of flash while that happens.
  disarmButton();
  pusher.wait();
  setLed(LedState::Upload, "taking a .bin over USB");

  // The pixel stream and the transfer share one cable. A mirrored head is pushing six
  // kilobytes a frame up the same port the .bin is coming down, and the acks that pace the
  // transfer have to be found in among it - so hold the stream for the duration and put it
  // back afterwards, rather than making someone remember to stop mirroring before flashing.
  const bool was_streaming = streaming;
  streaming = false;

  const bool ok = upload::receiveOverSerial(runtime);

  // Whatever is left of a transfer that went wrong is still sitting in the receive buffer,
  // and the next thing to read that buffer is serialRequest() - which would find `p`s, `u`s
  // and 0x02s in the middle of somebody's face data and act on them. One failed flash would
  // then turn into a head that starts mirroring, drops into upload mode, or begins a second
  // phantom transfer, and the next attempt fails differently than the first.
  if (!ok) {
    // Until the port has been quiet for a moment, not just until it is empty right now: the
    // host stops sending when it sees the error line, but what it had already put on the
    // wire is still on its way.
    uint32_t quiet_since = millis();
    while (millis() - quiet_since < 50) {
      if (Serial.read() >= 0) quiet_since = millis();
    }
  }

  streaming = was_streaming;

  // The transfer is not a frame, and averaging it into the frame time would report a face
  // running at 0.4 fps for the next two seconds.
  stats = Stats{};
  stats.since = millis();
  return ok;
}

// A slow blue pulse across every panel, so you can see from the other side of the room that
// the head is waiting for a file rather than rendering a face. The VM is deliberately not
// running here: upload mode erases the bytes it would be reading.
void showUploadIndicator() {
  const uint8_t v = uint8_t(40.0f + 60.0f * (0.5f + 0.5f * sinf(millis() / 500.0f)));
  for (size_t i = 0; i < size_t(CANVAS_W) * CANVAS_H; i++) back[i] = Pixel{0, uint8_t(v / 3), v};
  // trySubmit, not submit: this loop is also the web server. The push task is pinned to the
  // core the radio owns, so while a browser is talking to the head the push is the thing
  // that waits - and blocking here on it means not answering the request that is keeping
  // the radio busy. The browser retries, the radio stays busy, and the head sits there doing
  // neither: the page never loads and the panels never change, which is exactly what a
  // frozen head looks like. A dropped indicator frame costs nothing; a dropped request costs
  // upload mode.
  if (pusher.trySubmit(back)) swapCanvases();
}

// ---------------------------------------------------------------------------

void setup() {
  // Before begin(), which is when the driver allocates it.
  //
  // This is not a tuning knob, it is the flash protocol's one hardware requirement. The
  // editor sends a .bin in chunks of kSerialChunk and waits for an ack before sending the
  // next, so exactly one chunk is ever in flight - but the USB receive interrupt DROPS
  // whatever does not fit in this buffer, and the default is smaller than a chunk. A file
  // that fits in one chunk therefore flashes fine and anything bigger loses bytes in the
  // middle, which comes back as "the transfer stopped halfway" on a file that is perfectly
  // good. One chunk plus room for the header makes the overflow impossible rather than
  // unlikely; test/check-sketch.mjs holds this number against both ends of the protocol.
  Serial.setRxBufferSize(kSerialRxBuffer);
  Serial.begin(115200);
  delay(200);

  // millis() is already running when setup() is entered: everything the ESP-IDF does on the
  // way here is on the clock, and the light is red for all of it. PSRAM is the usual reason
  // that number is large - probing for a chip the board does not have, or probing octal on a
  // board wired quad, costs seconds before a line of this sketch runs. Nothing here allocates
  // out of PSRAM, so if this says it found none and the boot is still slow, turn PSRAM off in
  // Tools rather than hunting through setup().
  const uint32_t boot_ms = millis();
  Serial.printf("boot: %lu ms before setup(), PSRAM %s\n", (unsigned long)boot_ms,
                psramFound() ? "found" : "none (fine - nothing here wants it)");

  // Red until setup finishes: if it hangs or crashes on the way, the light says so instead
  // of staying dark and looking like a dead board.
  setLed(LedState::Error, "starting up");

  pinMode(BUTTON_PIN, BUTTON_ACTIVE_LOW ? INPUT_PULLUP : INPUT_PULLDOWN);
  delay(10);  // let the pull settle before reading it
  // Reads PRESSED with nothing touched means the pin or the polarity is wrong, and that is
  // worth knowing at boot rather than after a minute of pressing a button that does nothing.
  Serial.printf("button: GPIO %d reads %s at boot%s\n", BUTTON_PIN,
                buttonDown() ? "PRESSED" : "released",
                buttonDown() ? "  <-- wrong pin, or BUTTON_ACTIVE_LOW is inverted" : "");
  armButton();

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

  reportConfig();

  if (!renderer.begin()) fail("renderer.begin() failed - out of memory?");
  if (!pusher.begin(PANELS, PANEL_COUNT, CANVAS_W, CANVAS_H, panelScratch)) {
    fail("pusher.begin() failed - out of memory?");
  }

  stats.since = millis();
  // The time, because the light is red for all of it: if the head sits red for seconds on
  // end, this line and the one from the first frame say which half of the boot ate them.
  Serial.printf("face running at %ux%u, setup took %lu ms. Press the button within %lu s for\n"
                "upload mode, or type u here at any time, p to mirror the canvas, or flash it\n"
                "straight over USB from the editor.\n",
                CANVAS_W, CANVAS_H, (unsigned long)(millis() - boot_ms),
                (unsigned long)(UPLOAD_WINDOW_MS / 1000));
}

void loop() {
  if (mode == Mode::Upload) {
    upload::handle();

    // The port is read here too. It used to be read only in face mode, which meant that once
    // the head was an access point it answered nothing over USB at all - the editor sent its
    // header, waited five seconds for "psflash ready" and reported a head that had gone
    // quiet. It had not; nobody was listening.
    switch (serialRequest()) {
      case Request::Flash:
        if (flashOverSerial()) {
          leaveUploadMode("flashed over USB");
          return;
        }
        break;  // refused: stay put so the next attempt has somewhere to land
      case Request::UploadMode:
        leaveUploadMode("asked on the serial monitor");
        return;
      case Request::None:
        break;
    }

    if (buttonPolled()) {
      leaveUploadMode("the button");
      return;
    }
    const uint32_t landed = upload::lastUploadAt();
    if (UPLOAD_RETURN_MS != 0 && landed != 0 && millis() - landed >= UPLOAD_RETURN_MS) {
      leaveUploadMode("a .bin landed");
      return;
    }
    if (UPLOAD_IDLE_MS != 0 && millis() - upload::lastRequestAt() >= UPLOAD_IDLE_MS) {
      leaveUploadMode("nothing asked of it for a while");
      return;
    }

    // Blue while it waits; red if the last .bin was refused, so you can see a bad upload
    // without going back to the browser tab.
    setLed(fault || upload::lastUploadFailed() ? LedState::Error : LedState::Upload,
           upload::lastUploadFailed() ? "the last upload was rejected" : "waiting for a .bin");
    showUploadIndicator();
    delay(10);
    return;
  }

  switch (serialRequest()) {
    case Request::UploadMode:
      enterUploadMode();
      return;
    case Request::Flash:
      flashOverSerial();
      return;
    case Request::None:
      break;
  }

  // The window is measured from boot. Past it the button does nothing at all, which is the
  // point - but say so once, or a press at 61 seconds looks like a broken button.
  static bool window_closed = false;
  if (!window_closed && millis() < UPLOAD_WINDOW_MS) {
    if (buttonNoisy()) {
      window_closed = true;
      disarmButton();
    } else if (buttonPressed()) {
      enterUploadMode();
      return;
    }
  } else if (!window_closed) {
    window_closed = true;
    disarmButton();
    Serial.println("upload window closed - power-cycle for the button, or type u here");
  }

  renderFace();
}
