#pragma once
#include <cstddef>
#include <cstdint>

// Portable core: NO Arduino.h, NO emscripten, NO FreeRTOS here. Plain C++ only, so the
// exact same code runs on the ESP32-S3 and in the browser via wasm.
//
// Threading lives OUTSIDE this class on purpose. wasm has no FreeRTOS, so the core cannot
// spawn tasks; instead it exposes renderRows(), and the platform splits the frame across
// cores (see ProtoShadeParallel.h for the ESP32 side). That only works if sampling has no
// shared mutable state, which is why per-frame values are passed as an immutable Frame and
// per-thread scratch lives in a caller-owned ExecContext.

namespace protoshade {

struct Pixel {
  uint8_t r, g, b;
};

enum class Status : uint8_t {
  Ok = 0,
  NoProgram,      // nothing loaded yet - sample() falls back to the built-in test pattern
  TooSmall,       // blob shorter than a header
  BadMagic,
  BadVersion,     // built by a newer (or older) web app than this firmware understands
  BadLayout,      // an offset/length in the blob points outside the blob
  BadResolution,
};

// Asset pixel formats. PNGs are decoded and converted by the web app at pack time - the
// device never decodes PNG, it just points at bytes.
enum class AssetFormat : uint8_t {
  RGB565 = 0,   // 2 bytes/px, the native format for most panels
  RGBA8888 = 1, // 4 bytes/px, when a shader needs alpha
  A8 = 2,       // 1 byte/px, masks
};

struct Asset {
  const uint8_t* data;
  uint32_t length;
  uint16_t width, height;
  AssetFormat format;
};

// Per-frame values, computed once and shared read-only by every core rendering that frame.
struct Frame {
  uint32_t ms;     // time base handed to the shader
  uint32_t index;  // frame counter, for effects that want it
};

// Per-thread scratch. One per rendering thread - never share one across cores.
// Today it only carries the step budget; the VM's stack and registers land here too, which
// is exactly why it is caller-owned rather than a member of the runtime.
struct ExecContext {
  // Hard ceiling on work per pixel. A program from the web is untrusted input: without a
  // budget a bad loop is a watchdog reset with the visor on someone's head.
  uint32_t step_limit = 4096;
  uint32_t steps_used = 0;   // reset per pixel
  bool budget_exceeded = false;  // sticky, so a frame can be flagged without checking per pixel
};

// Binary container layout, little-endian. Both targets are little-endian, but the fields are
// read byte-wise anyway so a mismatch can never silently misparse.
//
//   offset  size  field
//   0       4     magic "PSHD"
//   4       2     format_version
//   6       2     flags
//   8       2     width_hint       resolution the program was authored for (0 = any)
//   10      2     height_hint
//   12      4     code_offset
//   16      4     code_length
//   20      2     asset_count
//   22      2     reserved
//   24      4     asset_table_offset   asset_count entries of 16 bytes
//   28      4     total_length         must equal the blob length
//   32            end of header
//
// Asset table entry:
//   0       4     data_offset
//   4       4     data_length
//   8       2     width
//   10      2     height
//   12      1     format (AssetFormat)
//   13      3     reserved
namespace format {
constexpr uint8_t kMagic[4] = {'P', 'S', 'H', 'D'};
constexpr uint16_t kVersion = 1;       // bump on every layout change; old firmware then refuses new bins
constexpr size_t kHeaderSize = 32;
constexpr size_t kAssetEntrySize = 16;
constexpr uint16_t kMaxDimension = 512;  // sanity cap, not a hardware limit
}  // namespace format

class ProtoShadeRuntime {
public:
  ProtoShadeRuntime() = default;
  ProtoShadeRuntime(uint16_t width, uint16_t height) { setResolution(width, height); }

  // Point the runtime at a compiled program. The bytes are NOT copied: on the ESP32 this is
  // meant to be a pointer into a flash partition mapped with esp_partition_mmap(), which
  // costs no RAM. The caller must keep the data alive for as long as the runtime uses it.
  // Every offset in the blob is validated here, so sampling never has to re-check.
  bool load(const uint8_t* program, size_t length);

  void unload();
  Status status() const { return status_; }
  bool hasProgram() const { return status_ == Status::Ok; }

  // Resolution to render at. Independent of the program's width_hint: a program authored for
  // 64x32 can be sampled at any size, it just gets different coordinates.
  bool setResolution(uint16_t width, uint16_t height);
  uint16_t width() const { return w_; }
  uint16_t height() const { return h_; }
  uint16_t programWidthHint() const { return prog_w_; }
  uint16_t programHeightHint() const { return prog_h_; }

  // Assets packed alongside the code (converted PNGs).
  uint16_t assetCount() const { return asset_count_; }
  bool asset(uint16_t index, Asset& out) const;

  Frame beginFrame(uint32_t ms) const { return Frame{ms, frame_index_++}; }

  // Sample one pixel. const and free of shared mutable state, so two cores may call it at
  // the same time as long as each passes its own ExecContext.
  // Out-of-range coordinates return black rather than reading out of bounds.
  Pixel sample(ExecContext& ctx, const Frame& frame, uint16_t x, uint16_t y) const;

  // Render rows [y0, y1) into dst, row-major, width() pixels per row. dst holds
  // (y1 - y0) * width() pixels. This is the unit of work handed to a core.
  void renderRows(ExecContext& ctx, const Frame& frame, uint16_t y0, uint16_t y1, Pixel* dst) const;

  void renderFrame(ExecContext& ctx, const Frame& frame, Pixel* dst) const {
    renderRows(ctx, frame, 0, h_, dst);
  }

private:
  Pixel testPattern(const Frame& frame, uint16_t x, uint16_t y) const;

  const uint8_t* blob_ = nullptr;
  size_t blob_len_ = 0;
  const uint8_t* code_ = nullptr;
  uint32_t code_len_ = 0;
  const uint8_t* asset_table_ = nullptr;
  uint16_t asset_count_ = 0;
  uint16_t prog_w_ = 0, prog_h_ = 0;

  uint16_t w_ = 8, h_ = 8;
  mutable uint32_t frame_index_ = 0;  // only touched by beginFrame(), never while rendering
  Status status_ = Status::NoProgram;
};

}  // namespace protoshade
