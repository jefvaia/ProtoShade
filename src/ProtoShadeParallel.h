#pragma once

// The ONLY non-portable file in src/. Splits a frame across both ESP32 cores; compiles to
// nothing anywhere else, so wasm and other boards are unaffected.
#if defined(ARDUINO_ARCH_ESP32) || defined(ESP32)

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

#include "ProtoShadeDisplay.h"
#include "ProtoShadeRuntime.h"

namespace protoshade {

// Renders the top half on core 0 and the bottom half on core 1, then waits for both.
//
// Two long-lived tasks, not one pair per frame: creating a task costs ~30us and fragments
// the heap, which at 60fps is real. Each task owns its own ExecContext - that is the whole
// reason sample() takes one by reference.
//
// ponytail: fixed at a two-way split, because the S3 has two cores. If a later chip has more,
// turn halves_ into an array of ranges and loop.
class ParallelRenderer {
public:
  // stack_words: 4096 is ample for the current shell. Raise it when the VM gets a deep stack.
  bool begin(uint32_t stack_words = 4096, UBaseType_t priority = 1);
  void end();

  // Blocks until both halves are done. dst holds width() * height() pixels.
  // Returns false if either half blew its step budget - the frame is still rendered.
  bool render(const ProtoShadeRuntime& rt, const Frame& frame, Pixel* dst);

  // Step budget handed to both halves (see ExecContext).
  void setStepLimit(uint32_t limit) { step_limit_ = limit; }

  // Microseconds the given half spent inside renderRows() on the last frame - the wait for
  // the other half is not in it. The split is a fixed 50/50 and core 0 has the rest of the
  // system on it, so a frame costs whatever the SLOWER half costs: these two numbers are
  // how far apart they actually are, which is the thing to know before splitting unevenly.
  uint32_t halfMicros(uint8_t index) const { return index < 2 ? halves_[index].last_us : 0; }

private:
  struct Half {
    ParallelRenderer* owner;
    uint8_t index;              // 0 = top, 1 = bottom
    TaskHandle_t task;
    SemaphoreHandle_t start;
    ExecContext ctx;            // per-core scratch, never shared
    uint32_t last_us;           // time in renderRows() on the last frame
  };

  static void taskEntry(void* arg);
  void runHalf(Half& half);

  const ProtoShadeRuntime* rt_ = nullptr;
  const Frame* frame_ = nullptr;
  Pixel* dst_ = nullptr;
  uint32_t step_limit_ = 4096;
  Half halves_[2] = {};
  SemaphoreHandle_t done_ = nullptr;  // counting semaphore, given once per finished half
  bool running_ = false;
};

// Pushes finished frames to the panels from its own task, so the next frame renders while
// the last one is still going out. Give it two canvases and alternate:
//
//   pusher.submit(a);   // returns as soon as the task has taken it
//   render into b;      // overlaps the push of a
//   pusher.submit(b);   // waits for a's push to finish, then hands over b
//   render into a;      // a is free: submit(b) did not return until its push was done
//
// That is the whole synchronisation. With exactly two buffers no frame is ever rendered
// into while it is being sent, and there is no lock in the render path at all.
//
// Worth it when a driver blocks - bit-banged SPI, a WS2812 string. With HUB75 over I2S DMA
// the push is nearly free and this mostly buys you the scratch copy for rotated panels.
class PanelPusher {
public:
  // panels, canvas size and scratch must outlive the pusher; nothing here is copied.
  // scratch holds the largest panel's pixel count - it is written only by this task, which
  // is why it must not be the same buffer the caller uses for anything else.
  // Pinned to core 0 by default: core 1 is where Arduino's loop() and the heavier half of
  // the render live.
  bool begin(const Panel* panels, size_t count, uint16_t canvas_w, uint16_t canvas_h,
             Pixel* scratch, BaseType_t core = 0, uint32_t stack_words = 4096,
             UBaseType_t priority = 1);
  void end();

  // Hands a finished frame over. Blocks only until the previous push is done, which is the
  // back pressure that makes two buffers enough.
  void submit(const Pixel* frame);

  // The same thing for a caller that must not block: hands the frame over if the previous
  // push has finished, and says no if it has not. Upload mode is the caller - the loop that
  // draws the waiting indicator is also the loop that runs the web server, and the push task
  // sits on the core the radio owns. Waiting for a panel there means not answering the
  // browser, which means the browser retries, which means the radio stays busy and the push
  // stays starved: the head looks frozen exactly when someone is trying to reach it.
  bool trySubmit(const Pixel* frame);

  // Blocks until nothing is in flight. Call it before you touch either buffer outside the
  // alternating pattern above - switching modes, or shutting down.
  void wait();

  bool running() const { return running_; }

private:
  static void taskEntry(void* arg);

  const Panel* panels_ = nullptr;
  size_t count_ = 0;
  uint16_t canvas_w_ = 0, canvas_h_ = 0;
  Pixel* scratch_ = nullptr;
  const Pixel* frame_ = nullptr;
  TaskHandle_t task_ = nullptr;
  SemaphoreHandle_t start_ = nullptr;  // given by submit(), taken by the task
  SemaphoreHandle_t idle_ = nullptr;   // held while a push is in flight
  bool running_ = false;
};

}  // namespace protoshade

#endif  // ESP32
