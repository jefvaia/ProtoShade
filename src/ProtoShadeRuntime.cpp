#include "ProtoShadeRuntime.h"

namespace protoshade {
namespace {

uint16_t rd16(const uint8_t* p) { return uint16_t(p[0]) | uint16_t(p[1]) << 8; }
uint32_t rd32(const uint8_t* p) {
  return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}

// A program from the web app is untrusted input, so every span it declares is checked
// against the blob before anything dereferences it. Written to be overflow-proof: the
// additions are done in uint64_t so a huge offset cannot wrap around into "looks fine".
bool spanInside(uint32_t offset, uint32_t length, size_t blob_len) {
  return uint64_t(offset) + uint64_t(length) <= uint64_t(blob_len);
}

}  // namespace

bool ProtoShadeRuntime::load(const uint8_t* program, size_t length) {
  unload();

  if (!program || length < format::kHeaderSize) {
    status_ = Status::TooSmall;
    return false;
  }
  for (int i = 0; i < 4; i++) {
    if (program[i] != format::kMagic[i]) {
      status_ = Status::BadMagic;
      return false;
    }
  }
  if (rd16(program + 4) != format::kVersion) {
    status_ = Status::BadVersion;
    return false;
  }

  const uint32_t code_off = rd32(program + 12);
  const uint32_t code_len = rd32(program + 16);
  const uint16_t assets = rd16(program + 20);
  const uint32_t table_off = rd32(program + 24);
  const uint32_t total = rd32(program + 28);

  if (total != length || !spanInside(code_off, code_len, length) ||
      !spanInside(table_off, uint32_t(assets) * format::kAssetEntrySize, length)) {
    status_ = Status::BadLayout;
    return false;
  }

  // Asset spans are validated up front so asset() and the shader can skip the checks.
  for (uint16_t i = 0; i < assets; i++) {
    const uint8_t* entry = program + table_off + size_t(i) * format::kAssetEntrySize;
    if (!spanInside(rd32(entry), rd32(entry + 4), length)) {
      status_ = Status::BadLayout;
      return false;
    }
  }

  blob_ = program;
  blob_len_ = length;
  code_ = program + code_off;
  code_len_ = code_len;
  asset_table_ = assets ? program + table_off : nullptr;
  asset_count_ = assets;
  prog_w_ = rd16(program + 8);
  prog_h_ = rd16(program + 10);
  status_ = Status::Ok;
  return true;
}

void ProtoShadeRuntime::unload() {
  blob_ = code_ = asset_table_ = nullptr;
  blob_len_ = 0;
  code_len_ = 0;
  asset_count_ = prog_w_ = prog_h_ = 0;
  status_ = Status::NoProgram;
}

bool ProtoShadeRuntime::setResolution(uint16_t width, uint16_t height) {
  if (width == 0 || height == 0 || width > format::kMaxDimension || height > format::kMaxDimension) {
    if (status_ != Status::NoProgram) status_ = Status::BadResolution;
    return false;
  }
  w_ = width;
  h_ = height;
  return true;
}

bool ProtoShadeRuntime::asset(uint16_t index, Asset& out) const {
  if (index >= asset_count_ || !asset_table_) return false;
  const uint8_t* entry = asset_table_ + size_t(index) * format::kAssetEntrySize;
  out.data = blob_ + rd32(entry);
  out.length = rd32(entry + 4);
  out.width = rd16(entry + 8);
  out.height = rd16(entry + 10);
  out.format = AssetFormat(entry[12]);
  return true;
}

// Placeholder until the VM lands: the old diagonal wave, now in colour. Keeping it means the
// web preview and the example sketch stay runnable while the shader format is built out.
Pixel ProtoShadeRuntime::testPattern(const Frame& frame, uint16_t x, uint16_t y) const {
  const uint32_t phase = (uint32_t(x) + y) * 16 + frame.ms / 4;
  const uint8_t p = phase & 0xFF;                       // 0..255 sawtooth
  const uint8_t v = p < 128 ? p * 2 : uint8_t((255 - p) * 2);  // folded into a triangle wave
  return Pixel{0, v, v};
}

Pixel ProtoShadeRuntime::sample(ExecContext& ctx, const Frame& frame, uint16_t x, uint16_t y) const {
  ctx.steps_used = 0;
  if (x >= w_ || y >= h_) return Pixel{0, 0, 0};

  // TODO: execute code_/code_len_ here, spending ctx.step_limit and setting
  // ctx.budget_exceeded when a program runs away. Until then, the built-in pattern.
  return testPattern(frame, x, y);
}

void ProtoShadeRuntime::renderRows(ExecContext& ctx, const Frame& frame, uint16_t y0, uint16_t y1,
                                   Pixel* dst) const {
  if (!dst || y0 >= y1 || y1 > h_) return;
  for (uint16_t y = y0; y < y1; y++) {
    for (uint16_t x = 0; x < w_; x++) {
      *dst++ = sample(ctx, frame, x, y);
    }
  }
}

}  // namespace protoshade
