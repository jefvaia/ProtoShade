#include "ProtoShadeRuntime.h"

#include <cmath>
#include <cstring>

namespace protoshade {
namespace {

uint16_t rd16(const uint8_t* p) { return uint16_t(p[0]) | uint16_t(p[1]) << 8; }
uint32_t rd32(const uint8_t* p) {
  return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
// Little-endian float, assembled from bytes so the host's own byte order never leaks in.
float rdf32(const uint8_t* p) {
  const uint32_t bits = rd32(p);
  float f = 0.0f;
  std::memcpy(&f, &bits, sizeof f);
  return f;
}

// A program from the web app is untrusted input, so every span it declares is checked
// against the blob before anything dereferences it. Written to be overflow-proof: the
// additions are done in uint64_t so a huge offset cannot wrap around into "looks fine".
bool spanInside(uint32_t offset, uint64_t length, size_t blob_len) {
  return uint64_t(offset) + length <= uint64_t(blob_len);
}

constexpr uint8_t kConstFlag = 0x80;
constexpr uint8_t kOperandMask = 0x7F;

float clamp01(float x) { return x < 0.0f ? 0.0f : (x > 1.0f ? 1.0f : x); }

// Component-wise maths. Index order is the format - keep it in step with MATH_OPS in
// web/nodes.ts, and let test/crosscheck.mjs catch you when it drifts.
float mathOp(uint8_t op, float a, float b) {
  switch (op) {
    case 0: return a + b;
    case 1: return a - b;
    case 2: return a * b;
    // Zero denominators come from live widgets, not from bugs: returning 0 keeps inf and NaN
    // out of the pixel buffer, where they show up as black holes that are hard to trace.
    case 3: return b == 0.0f ? 0.0f : a / b;
    case 4: return a < 0.0f ? 0.0f : std::pow(a, b);
    // Floored modulo, so mod(-0.25, 1) is 0.75 and a scrolling coordinate stays continuous
    // across zero. C's fmod would give -0.25 and tear the pattern.
    case 5: return b == 0.0f ? 0.0f : a - std::floor(a / b) * b;
    case 6: return a < b ? a : b;
    case 7: return a > b ? a : b;
    case 8: return a > b ? 1.0f : 0.0f;
    case 9: return a < b ? 1.0f : 0.0f;
    case 10: return std::atan2(a, b);
    case 11: return std::sin(a);
    case 12: return std::cos(a);
    case 13: return std::fabs(a);
    case 14: return std::floor(a);
    case 15: return std::ceil(a);
    // Halfway cases go away from zero, matching JS Math.round on the values a shader sees.
    case 16: return std::floor(a + 0.5f);
    case 17: return a - std::floor(a);
    case 18: return a < 0.0f ? 0.0f : std::sqrt(a);
    case 19: return clamp01(a);
    case 20: {
      const float x = clamp01(a);
      return x * x * (3.0f - 2.0f * x);
    }
    default: return 0.0f;
  }
}

// Squash a sensor reading into 0..1 by saturating, so an unbounded one never flatlines.
float toUnit(uint8_t range, float x) {
  switch (range) {
    case 0: return clamp01(x);
    case 1: return clamp01(x * 0.5f + 0.5f);
    case 2: return x <= 0.0f ? 0.0f : x / (1.0f + x);
    case 3: return 0.5f + (0.5f * x) / (1.0f + std::fabs(x));
    // Degrees wrap rather than clamp: at 359 a head is one degree from 0, not at the far end.
    case 4: return (std::fmod(std::fmod(x, 360.0f) + 360.0f, 360.0f)) / 360.0f;
    default: return 0.0f;
  }
}

void broadcast(float* dst, float x) {
  dst[0] = dst[1] = dst[2] = x;
  dst[3] = 1.0f;
}

void hsvToRgb(float* dst, float h, float s, float v, float a) {
  const float hh = (h - std::floor(h)) * 6.0f;
  const float c = clamp01(v) * clamp01(s);
  const float x = c * (1.0f - std::fabs(std::fmod(hh, 2.0f) - 1.0f));
  const float m = clamp01(v) - c;
  const int i = int(std::floor(hh)) % 6;
  float r = c, g = x, b = 0.0f;
  switch (i) {
    case 0: r = c; g = x; b = 0.0f; break;
    case 1: r = x; g = c; b = 0.0f; break;
    case 2: r = 0.0f; g = c; b = x; break;
    case 3: r = 0.0f; g = x; b = c; break;
    case 4: r = x; g = 0.0f; b = c; break;
    default: r = c; g = 0.0f; b = x; break;
  }
  dst[0] = r + m;
  dst[1] = g + m;
  dst[2] = b + m;
  dst[3] = a;
}

// How many operands each op actually reads. The other operand bytes in the instruction are
// don't-care padding, so validation must not treat them as register reads - a one-operand
// op would otherwise be rejected for "reading" register 0 before anything wrote it.
uint8_t operandCount(uint8_t op) {
  switch (Op(op)) {
    case Op::UV:
    case Op::Centered:
    case Op::PixelPos: return 0;
    case Op::Time:
    case Op::Sensor:
    case Op::Swizzle:
    case Op::Tex: return 1;
    case Op::Math:
    case Op::Output: return 2;
    case Op::Mix:
    case Op::Over: return 3;
    case Op::Combine:
    case Op::Hsv: return 4;
    default: return 0;
  }
}

int32_t foldCoord(int32_t t, int32_t n, bool clamp) {
  if (clamp) return t < 0 ? 0 : (t >= n ? n - 1 : t);
  const int32_t m = t % n;
  return m < 0 ? m + n : m;
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
  const uint32_t const_off = rd32(program + 20);
  const uint16_t consts = rd16(program + 24);
  const uint8_t regs = program[26];
  const uint8_t sensors = program[27];
  const uint16_t assets = rd16(program + 28);
  const uint32_t table_off = rd32(program + 32);
  const uint32_t total = rd32(program + 36);

  if (total != length || code_len % format::kInstrSize != 0 ||
      !spanInside(code_off, code_len, length) ||
      !spanInside(const_off, uint64_t(consts) * 16, length) ||
      !spanInside(table_off, uint64_t(assets) * format::kAssetEntrySize, length)) {
    status_ = Status::BadLayout;
    return false;
  }
  if (consts > format::kMaxConstants || regs > format::kMaxRegisters ||
      assets > format::kMaxAssets || code_len / format::kInstrSize > format::kMaxInstructions) {
    status_ = Status::BadProgram;
    return false;
  }

  // Asset spans are validated up front so asset() and the shader can skip the checks.
  for (uint16_t i = 0; i < assets; i++) {
    const uint8_t* entry = program + table_off + size_t(i) * format::kAssetEntrySize;
    const uint32_t off = rd32(entry);
    const uint32_t len = rd32(entry + 4);
    const uint16_t aw = rd16(entry + 8);
    const uint16_t ah = rd16(entry + 10);
    const uint8_t fmt = entry[12];
    if (!spanInside(off, len, length) || aw == 0 || ah == 0 || fmt > uint8_t(AssetFormat::A8)) {
      status_ = Status::BadLayout;
      return false;
    }
    // The shader indexes texels without re-checking, so prove here that every texel of
    // every asset is inside the declared span.
    const uint64_t stride = fmt == uint8_t(AssetFormat::RGBA8888) ? 4 : (fmt == uint8_t(AssetFormat::A8) ? 1 : 2);
    if (uint64_t(aw) * uint64_t(ah) * stride > uint64_t(len)) {
      status_ = Status::BadLayout;
      return false;
    }
  }

  blob_ = program;
  blob_len_ = length;
  std::memcpy(code_, program + code_off, code_len);
  instr_count_ = uint16_t(code_len / format::kInstrSize);
  asset_table_ = assets ? program + table_off : nullptr;
  asset_count_ = assets;
  const_count_ = consts;
  reg_count_ = regs;
  sensor_count_ = sensors;
  prog_w_ = rd16(program + 8);
  prog_h_ = rd16(program + 10);
  for (uint16_t i = 0; i < consts; i++) {
    for (int c = 0; c < 4; c++) consts_[i][c] = rdf32(program + const_off + size_t(i) * 16 + c * 4);
  }
  for (uint16_t i = 0; i < assets; i++) {
    const uint8_t* entry = program + table_off + size_t(i) * format::kAssetEntrySize;
    assets_[i] = AssetRef{program + rd32(entry), int32_t(rd16(entry + 8)), int32_t(rd16(entry + 10)),
                          AssetFormat(entry[12])};
  }

  if (!validateCode()) {
    const Status why = status_;
    unload();
    status_ = why;
    return false;
  }

  status_ = Status::Ok;
  return true;
}

// Everything sample() would otherwise have to check per pixel: opcodes, operand indices,
// and that no instruction reads a register nothing has written yet. Straight-line code with
// all of that proven means the interpreter can be a switch with no guards in it.
bool ProtoShadeRuntime::validateCode() {
  if (instr_count_ == 0) {
    status_ = Status::BadProgram;
    return false;
  }

  uint64_t written = 0;  // one bit per register; kMaxRegisters is 64 for exactly this
  uint32_t cost = 0;
  for (uint16_t i = 0; i < instr_count_; i++) {
    const uint8_t* in = code_ + size_t(i) * format::kInstrSize;
    const uint8_t op = in[0];
    const uint8_t dst = in[1];
    const uint8_t aux = in[6];
    const uint8_t aux2 = in[7];
    if (op >= uint8_t(Op::kCount) || dst >= reg_count_) {
      status_ = Status::BadProgram;
      return false;
    }
    const uint8_t operands = operandCount(op);
    for (uint8_t s = 0; s < operands; s++) {
      const uint8_t o = in[2 + s];
      if (o & kConstFlag) {
        if ((o & kOperandMask) >= const_count_) {
          status_ = Status::BadProgram;
          return false;
        }
      } else if (o >= reg_count_ || !(written & (uint64_t(1) << o))) {
        status_ = Status::BadProgram;
        return false;
      }
    }
    if (op == uint8_t(Op::Math) && aux >= kMathOpCount) {
      status_ = Status::BadProgram;
      return false;
    }
    if (op == uint8_t(Op::Sensor) && (aux2 >> 1) >= kRangeCount) {
      status_ = Status::BadProgram;
      return false;
    }
    if (op == uint8_t(Op::Tex) && aux >= asset_count_) {
      status_ = Status::BadProgram;
      return false;
    }
    written |= uint64_t(1) << dst;
    // A bilinear fetch is four texels and the lerps between them; everything else is
    // roughly one step. Rough on purpose: this only has to bound the work, not price it.
    cost += (op == uint8_t(Op::Tex) && (aux2 & 2)) ? 8 : 1;
  }

  // sample() returns the last instruction's register, so the program has to end by writing
  // the pixel. Anything else is a program that computes nothing.
  if (code_[size_t(instr_count_ - 1) * format::kInstrSize] != uint8_t(Op::Output)) {
    status_ = Status::BadProgram;
    return false;
  }
  cost_ = cost;
  return true;
}

void ProtoShadeRuntime::unload() {
  blob_ = asset_table_ = nullptr;
  blob_len_ = 0;
  instr_count_ = 0;
  asset_count_ = prog_w_ = prog_h_ = const_count_ = 0;
  reg_count_ = sensor_count_ = 0;
  cost_ = 0;
  status_ = Status::NoProgram;
}

bool ProtoShadeRuntime::setResolution(uint16_t width, uint16_t height) {
  if (width == 0 || height == 0 || width > format::kMaxDimension || height > format::kMaxDimension) {
    if (status_ != Status::NoProgram) status_ = Status::BadResolution;
    return false;
  }
  w_ = width;
  h_ = height;
  inv_w_ = 1.0f / float(width);
  inv_h_ = 1.0f / float(height);
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

void ProtoShadeRuntime::texel(uint16_t index, int32_t x, int32_t y, bool clamp, float* rgba) const {
  const AssetRef& a = assets_[index];
  const uint8_t* data = a.data;
  const size_t at = size_t(foldCoord(y, a.h, clamp)) * size_t(a.w) + size_t(foldCoord(x, a.w, clamp));

  switch (a.format) {
    case AssetFormat::RGBA8888:
      for (int c = 0; c < 4; c++) rgba[c] = data[at * 4 + c] / 255.0f;
      break;
    case AssetFormat::A8:
      rgba[0] = rgba[1] = rgba[2] = 1.0f;
      rgba[3] = data[at] / 255.0f;
      break;
    default: {
      const uint16_t v = rd16(data + at * 2);
      rgba[0] = float((v >> 11) & 31) / 31.0f;
      rgba[1] = float((v >> 5) & 63) / 63.0f;
      rgba[2] = float(v & 31) / 31.0f;
      rgba[3] = 1.0f;
      break;
    }
  }
}

// Placeholder for when there is no program: the old diagonal wave, in colour. It is what a
// freshly flashed head shows before anyone has uploaded a .bin.
Pixel ProtoShadeRuntime::testPattern(const Frame& frame, uint16_t x, uint16_t y) const {
  const uint32_t phase = (uint32_t(x) + y) * 16 + frame.ms / 4;
  const uint8_t p = phase & 0xFF;                       // 0..255 sawtooth
  const uint8_t v = p < 128 ? p * 2 : uint8_t((255 - p) * 2);  // folded into a triangle wave
  return Pixel{0, v, v};
}

Pixel ProtoShadeRuntime::sample(ExecContext& ctx, const Frame& frame, uint16_t x, uint16_t y) const {
  if (x >= w_ || y >= h_) return Pixel{0, 0, 0};
  if (status_ != Status::Ok) return testPattern(frame, x, y);

  // The ISA has no jumps, so the cost of a pixel is known before the first one is drawn:
  // one comparison here replaces accounting inside the loop.
  ctx.steps_used = cost_;
  if (cost_ > ctx.step_limit) {
    ctx.budget_exceeded = true;
    return Pixel{0, 0, 0};
  }

  const float u = (float(x) + 0.5f) * inv_w_;
  const float v = (float(y) + 0.5f) * inv_h_;
  const float t = frame.seconds;

  // Operand -> the four floats it names. Validated at load, so no checks in here.
  auto src = [&](const uint8_t* in, int slot) -> const float* {
    const uint8_t o = in[2 + slot];
    return (o & kConstFlag) ? consts_[o & kOperandMask] : ctx.regs[o];
  };

  float* dst = ctx.regs[0];
  for (uint16_t i = 0; i < instr_count_; i++) {
    const uint8_t* in = code_ + size_t(i) * format::kInstrSize;
    const uint8_t aux = in[6];
    const uint8_t aux2 = in[7];
    dst = ctx.regs[in[1]];
    const float* a = src(in, 0);

    switch (Op(in[0])) {
      case Op::UV:
        dst[0] = u; dst[1] = v; dst[2] = 0.0f; dst[3] = 1.0f;
        break;
      case Op::Centered:
        // Aspect-corrected, so a circle on a 64x32 panel stays round.
        dst[0] = (u * 2.0f - 1.0f) * (float(w_) / float(h_ ? h_ : 1));
        dst[1] = v * 2.0f - 1.0f;
        dst[2] = 0.0f;
        dst[3] = 1.0f;
        break;
      case Op::PixelPos:
        dst[0] = float(x); dst[1] = float(y); dst[2] = 0.0f; dst[3] = 1.0f;
        break;
      case Op::Time:
        broadcast(dst, t * a[0]);
        break;
      case Op::Sensor: {
        // A head with fewer sensors than the program expects still runs it: the missing
        // slot reads the value the author left in the node.
        const float raw = aux < frame.sensors.count && frame.sensors.values
                              ? frame.sensors.values[aux]
                              : a[0];
        broadcast(dst, (aux2 & 1) ? toUnit(uint8_t(aux2 >> 1), raw) : raw);
        break;
      }
      case Op::Math: {
        const float* b = src(in, 1);
        dst[0] = mathOp(aux, a[0], b[0]);
        dst[1] = mathOp(aux, a[1], b[1]);
        dst[2] = mathOp(aux, a[2], b[2]);
        // Alpha rides through from A: scaling a colour must not change its coverage, and a
        // scalar B broadcasts to alpha 1, which add and divide would wreck.
        dst[3] = a[3];
        break;
      }
      case Op::Mix: {
        const float* A = src(in, 1);
        const float* B = src(in, 2);
        for (int c = 0; c < 4; c++) dst[c] = A[c] + (B[c] - A[c]) * a[0];
        break;
      }
      case Op::Over: {
        const float* fg = src(in, 1);
        const float* bg = src(in, 2);
        const float af = clamp01(fg[3]) * clamp01(a[0]);
        const float ab = clamp01(bg[3]);
        const float alpha = af + ab * (1.0f - af);
        if (alpha == 0.0f) {
          // Fully transparent: the colour is meaningless, keep it black instead of 0/0.
          dst[0] = dst[1] = dst[2] = dst[3] = 0.0f;
        } else {
          // Straight (un-premultiplied) alpha in and out, so two of these compose.
          for (int c = 0; c < 3; c++) dst[c] = (fg[c] * af + bg[c] * ab * (1.0f - af)) / alpha;
          dst[3] = alpha;
        }
        break;
      }
      case Op::Swizzle:
        broadcast(dst, a[aux & 3]);
        break;
      case Op::Combine:
        for (int c = 0; c < 4; c++) dst[c] = src(in, c)[0];
        break;
      case Op::Hsv:
        hsvToRgb(dst, a[0], src(in, 1)[0], src(in, 2)[0], src(in, 3)[0]);
        break;
      case Op::Tex: {
        const bool clamp = (aux2 & 1) != 0;
        const float aw = float(assets_[aux].w);
        const float ah = float(assets_[aux].h);
        float rgba[4];
        if (!(aux2 & 2)) {
          texel(aux, int32_t(std::floor(a[0] * aw)), int32_t(std::floor(a[1] * ah)), clamp, rgba);
        } else {
          const float fx = a[0] * aw - 0.5f;
          const float fy = a[1] * ah - 0.5f;
          const int32_t x0 = int32_t(std::floor(fx));
          const int32_t y0 = int32_t(std::floor(fy));
          const float tx = fx - float(x0);
          const float ty = fy - float(y0);
          float p00[4], p10[4], p01[4], p11[4];
          texel(aux, x0, y0, clamp, p00);
          texel(aux, x0 + 1, y0, clamp, p10);
          texel(aux, x0, y0 + 1, clamp, p01);
          texel(aux, x0 + 1, y0 + 1, clamp, p11);
          for (int c = 0; c < 4; c++) {
            const float top = p00[c] + (p10[c] - p00[c]) * tx;
            const float bottom = p01[c] + (p11[c] - p01[c]) * tx;
            rgba[c] = top + (bottom - top) * ty;
          }
        }
        if (aux2 & 4) {
          broadcast(dst, rgba[3]);
        } else {
          for (int c = 0; c < 4; c++) dst[c] = rgba[c];
        }
        break;
      }
      case Op::Output: {
        // An LED is on or off; there is nothing behind it to show through, so alpha
        // composites against black here - the one place transparency gets resolved.
        const float k = src(in, 1)[0] * clamp01(a[3]);
        dst[0] = clamp01(a[0] * k);
        dst[1] = clamp01(a[1] * k);
        dst[2] = clamp01(a[2] * k);
        dst[3] = 1.0f;
        break;
      }
      default:
        broadcast(dst, 0.0f);
        break;
    }
  }

  // Round, do not truncate: the preview does Math.round on the same floats, and half a
  // level of difference on every channel is exactly the kind of drift nobody would chase.
  // Output has already clamped to 0..1, so no negative can reach this.
  return Pixel{uint8_t(dst[0] * 255.0f + 0.5f), uint8_t(dst[1] * 255.0f + 0.5f),
               uint8_t(dst[2] * 255.0f + 0.5f)};
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
