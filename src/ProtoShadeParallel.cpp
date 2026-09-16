#include "ProtoShadeParallel.h"

#if defined(ARDUINO_ARCH_ESP32) || defined(ESP32)

namespace protoshade {

bool ParallelRenderer::begin(uint32_t stack_words, UBaseType_t priority) {
  if (running_) return true;

  done_ = xSemaphoreCreateCounting(2, 0);
  if (!done_) return false;

  for (uint8_t i = 0; i < 2; i++) {
    halves_[i].owner = this;
    halves_[i].index = i;
    halves_[i].start = xSemaphoreCreateBinary();
    if (!halves_[i].start) {
      end();
      return false;
    }
    // Pinned: core 0 also runs WiFi/BT, so if you ever add networking, expect the top half
    // to be the slower one and split unevenly rather than 50/50.
    const BaseType_t ok = xTaskCreatePinnedToCore(taskEntry, i == 0 ? "psh_top" : "psh_bot",
                                                 stack_words, &halves_[i], priority,
                                                 &halves_[i].task, i);
    if (ok != pdPASS) {
      end();
      return false;
    }
  }
  running_ = true;
  return true;
}

void ParallelRenderer::end() {
  for (Half& h : halves_) {
    if (h.task) vTaskDelete(h.task);
    if (h.start) vSemaphoreDelete(h.start);
    h.task = nullptr;
    h.start = nullptr;
  }
  if (done_) {
    vSemaphoreDelete(done_);
    done_ = nullptr;
  }
  running_ = false;
}

void ParallelRenderer::taskEntry(void* arg) {
  Half* half = static_cast<Half*>(arg);
  for (;;) {
    xSemaphoreTake(half->start, portMAX_DELAY);
    half->owner->runHalf(*half);
    xSemaphoreGive(half->owner->done_);
  }
}

void ParallelRenderer::runHalf(Half& half) {
  const uint16_t h = rt_->height();
  const uint16_t split = h / 2;
  const uint16_t y0 = half.index == 0 ? 0 : split;
  const uint16_t y1 = half.index == 0 ? split : h;
  if (y0 >= y1) return;  // 1-pixel-tall frame: the top half has nothing to do

  half.ctx.step_limit = step_limit_;
  half.ctx.budget_exceeded = false;
  rt_->renderRows(half.ctx, *frame_, y0, y1, dst_ + size_t(y0) * rt_->width());
}

bool ParallelRenderer::render(const ProtoShadeRuntime& rt, const Frame& frame, Pixel* dst) {
  if (!running_ || !dst) return false;

  rt_ = &rt;
  frame_ = &frame;
  dst_ = dst;

  for (Half& h : halves_) xSemaphoreGive(h.start);
  for (int i = 0; i < 2; i++) xSemaphoreTake(done_, portMAX_DELAY);

  return !halves_[0].ctx.budget_exceeded && !halves_[1].ctx.budget_exceeded;
}

}  // namespace protoshade

#endif  // ESP32
