#pragma once

// The ONLY non-portable file in src/. Splits a frame across both ESP32 cores; compiles to
// nothing anywhere else, so wasm and other boards are unaffected.
#if defined(ARDUINO_ARCH_ESP32) || defined(ESP32)

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

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

private:
  struct Half {
    ParallelRenderer* owner;
    uint8_t index;              // 0 = top, 1 = bottom
    TaskHandle_t task;
    SemaphoreHandle_t start;
    ExecContext ctx;            // per-core scratch, never shared
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

}  // namespace protoshade

#endif  // ESP32
