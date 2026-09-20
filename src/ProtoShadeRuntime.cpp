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

// Channel value -> 0..1, as a table rather than a divide.
//
// The S3's FPU has no divide instruction - it is a reciprocal plus Newton steps - and these
// were the last divides left in a texel fetch: a bilinear RGBA fetch did sixteen of them.
// Multiplying by 1/255 instead would be a different number for 126 of the 256 bytes, so it
// is a table: each entry is the SAME divide, folded by the compiler with the same rounding,
// which keeps every texel bit-identical to before and test/crosscheck.mjs exact.
//
// Spelt with macros because the runtime still has to build under -std=gnu++11 for the older
// ESP32 core, where a constexpr constructor may not contain a loop. Constant expressions
// throughout, so these are .rodata - flash on the device, not RAM.
#define PSH_UNIT4(d, n) (n) / float(d), (n + 1) / float(d), (n + 2) / float(d), (n + 3) / float(d)
#define PSH_UNIT16(d, n) PSH_UNIT4(d, n), PSH_UNIT4(d, n + 4), PSH_UNIT4(d, n + 8), PSH_UNIT4(d, n + 12)
#define PSH_UNIT64(d, n) PSH_UNIT16(d, n), PSH_UNIT16(d, n + 16), PSH_UNIT16(d, n + 32), PSH_UNIT16(d, n + 48)
const float kOf31[32] = {PSH_UNIT16(31, 0), PSH_UNIT16(31, 16)};
const float kOf63[64] = {PSH_UNIT64(63, 0)};
const float kOf255[256] = {PSH_UNIT64(255, 0), PSH_UNIT64(255, 64), PSH_UNIT64(255, 128),
                           PSH_UNIT64(255, 192)};
#undef PSH_UNIT64
#undef PSH_UNIT16
#undef PSH_UNIT4

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

// How the foreground's colour is mixed with the background's WHERE THEY BOTH COVER. Index
// order is the format - keep it in step with BLEND_MODES in web/nodes.ts. Mode 0 is plain
// source-over, and the formula below reduces to exactly that, so every .bin built before
// blend modes existed renders the same byte for byte.
float blendOp(uint8_t mode, float cb, float cs) {
  switch (mode) {
    case 1: return cb * cs;                    // multiply
    case 2: return cb + cs - cb * cs;          // screen
    case 3: return cb + cs > 1.0f ? 1.0f : cb + cs;  // add
    case 4: return cb > cs ? cb : cs;          // lighten
    case 5: return cb < cs ? cb : cs;          // darken
    case 6: return std::fabs(cb - cs);         // difference
    default: return cs;                        // normal
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
    case Op::Anim:
    case Op::Output: return 2;
    case Op::Mix:
    case Op::Over: return 3;
    case Op::Combine:
    case Op::Particles:
    case Op::Hsv: return 4;
    default: return 0;
  }
}

int32_t foldCoord(int32_t t, int32_t n, Wrap wrap) {
  if (wrap == Wrap::Repeat) {
    const int32_t m = t % n;
    return m < 0 ? m + n : m;
  }
  return t < 0 ? 0 : (t >= n ? n - 1 : t);
}

// Fractional part, floored - the same one MATH's "fraction" uses, so a phase walking
// backwards past zero stays continuous.
float fract(float x) { return x - std::floor(x); }

// Integer hash (Murmur3's finaliser, with the mixing constants from Stafford's variant).
// The Particles instruction is stateless: a particle's whole life is a function of its
// index, so there is no per-frame state to keep and no order for two cores to disagree on.
uint32_t hashU32(uint32_t x) {
  x ^= x >> 16;
  x *= 0x7feb352dU;
  x ^= x >> 15;
  x *= 0x846ca68bU;
  x ^= x >> 16;
  return x;
}

// 0..1 from the TOP sixteen bits. Sixteen and not thirty-two on purpose: k/65536 is exact
// in both a float and a double, so the browser's preview and this VM start a particle from
// bit-identical numbers. Off by one ulp is normally invisible, but it lands on the wrong
// side of a texel edge often enough to show up as a wrong pixel in test/crosscheck.mjs.
float unitOf(uint32_t h) { return float(h >> 16) * (1.0f / 65536.0f); }

// Sine and cosine, ours rather than newlib's.
//
// Two reasons, and neither is speed for its own sake. First, web/graph.ts has to agree with
// this to the last bit or a rotated sprite picks a different texel in the preview than on
// the head - and the browser's Math.sin is a double's, which newlib's sinf is not. The same
// polynomial in the same order in both languages is agreement by construction. Second, this
// runs per particle per frame on a chip with no hardware trig, where sinf is a software call
// whose cost grows with the argument - and a rotation that has been spinning for an hour is
// a big argument.
//
// Range-reduced to a quadrant, then a 7th-order polynomial on |r| <= pi/4, where it is good
// to about 3e-7 - a third of a millionth of a turn, on a sprite a few pixels across.
void sinCos(float x, float& s, float& c) {
  // An angle that is finite and sane. Past a million radians a float has no fractional
  // angle left anyway, and the int() below must not be handed something out of its range -
  // the number came from a web page. This also catches NaN, which fails every comparison.
  if (!(x > -1.0e6f && x < 1.0e6f)) x = 0.0f;
  const float k = std::floor(x * 0.63661977f + 0.5f);  // 2/pi: which quadrant
  const float r = x - k * 1.5707964f;                  // pi/2
  const float r2 = r * r;
  // sin(r) and cos(r), Taylor, on the reduced angle.
  const float sr = r * (1.0f + r2 * (-0.16666667f + r2 * (0.008333333f + r2 * -0.00019841270f)));
  const float cr = 1.0f + r2 * (-0.5f + r2 * (0.041666668f + r2 * -0.0013888889f));
  // The quadrant decides which of the two is which, and the signs.
  const int q = int(k) & 3;
  switch (q < 0 ? q + 4 : q) {
    case 1: s = cr; c = -sr; break;
    case 2: s = -sr; c = -cr; break;
    case 3: s = -cr; c = sr; break;
    default: s = sr; c = cr; break;
  }
}

constexpr float kDegToRad = 0.017453292f;

// Straight-alpha source-over, in place: `dst` ends up as fg over dst. Same algebra as
// Op::Over, kept separate because that one is an instruction and this one runs in a loop.
void overInto(float* dst, const float* fg, float fa) {
  const float af = clamp01(fg[3]) * clamp01(fa);
  const float ab = clamp01(dst[3]);
  const float alpha = af + ab * (1.0f - af);
  if (alpha == 0.0f) {
    dst[0] = dst[1] = dst[2] = dst[3] = 0.0f;
    return;
  }
  // One reciprocal, three multiplies. Mirrored in web/graph.ts: the reciprocal is taken
  // there too, in the same order, so the two implementations round the same way.
  const float inv_alpha = 1.0f / alpha;
  for (int c = 0; c < 3; c++) dst[c] = (fg[c] * af + dst[c] * ab * (1.0f - af)) * inv_alpha;
  dst[3] = alpha;
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
    const uint16_t frames = rd16(entry + 13);
    if (!spanInside(off, len, length) || aw == 0 || ah == 0 || fmt > uint8_t(AssetFormat::A8) ||
        frames > ah) {
      // More frames than rows would leave a frame with no pixels in it; below, every frame
      // is proven to be inside the image, and the image inside the blob.
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
    const int32_t ah = int32_t(rd16(entry + 10));
    // 0 means "a still", so a container written before strips existed reads back unchanged.
    const uint16_t frames = rd16(entry + 13) ? rd16(entry + 13) : 1;
    assets_[i] = AssetRef{program + rd32(entry), int32_t(rd16(entry + 8)), ah,
                          AssetFormat(entry[12]), frames, ah / int32_t(frames)};
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
  bool uniform_reg[format::kMaxRegisters] = {};
  uint32_t cost = 0;
  uniform_count_ = 0;
  varying_count_ = 0;
  particle_emitters_ = 0;
  particle_total_ = 0;
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
    if (op == uint8_t(Op::Over) && aux >= kBlendCount) {
      status_ = Status::BadProgram;
      return false;
    }
    if (op == uint8_t(Op::Sensor) && (aux2 >> 1) >= kRangeCount) {
      status_ = Status::BadProgram;
      return false;
    }
    if ((op == uint8_t(Op::Tex) || op == uint8_t(Op::Anim)) &&
        (aux >= asset_count_ || (aux2 & 3) >= uint8_t(Wrap::kCount))) {
      status_ = Status::BadProgram;
      return false;
    }
    if (op == uint8_t(Op::Particles)) {
      // src2 names a block of kParticleQuads consecutive constants. Constants, not
      // registers: the count lives in there, and a register could hold anything by the time
      // the pixel runs - then the cost of a pixel would no longer be known before rendering
      // starts, which is the whole safety story.
      const uint8_t base = in[4] & kOperandMask;
      if (aux >= asset_count_ || !(in[4] & kConstFlag) ||
          uint16_t(base) + format::kParticleQuads > const_count_) {
        status_ = Status::BadProgram;
        return false;
      }
      // The clock must not vary across the frame either, because the per-particle state is
      // worked out once per frame from it. A constant or anything hoisted into the uniform
      // pass is fine; a pixel coordinate is not.
      const uint8_t clock = in[3];
      if (!(clock & kConstFlag) && !uniform_reg[clock]) {
        status_ = Status::BadProgram;
        return false;
      }
      // Each emitter gets a slice of the one particle table in ExecContext, so the budget
      // is the program's, not the instruction's.
      const float want = consts_[base][0];
      const uint32_t n = !(want > 0.0f) ? 0
                                        : (want >= float(format::kMaxParticles)
                                               ? format::kMaxParticles
                                               : uint32_t(want));
      if (particle_emitters_ >= format::kMaxParticles ||
          particle_total_ + n > format::kMaxParticles) {
        status_ = Status::BadProgram;
        return false;
      }
      particle_base_[i] = particle_total_;
      particle_instr_[particle_emitters_++] = uint8_t(i);
      particle_total_ += uint8_t(n);
    }
    // Written exactly once, never twice. The compiler allocates a fresh register per
    // instruction, and depending on that is what lets the uniform instructions be pulled
    // out of the pixel loop below without changing what anything downstream reads.
    if (written & (uint64_t(1) << dst)) {
      status_ = Status::BadProgram;
      return false;
    }
    written |= uint64_t(1) << dst;

    // Uniform: nothing in this instruction's inputs varies across the frame. The three
    // coordinate ops are where variation enters; everything else inherits it.
    bool is_uniform = op != uint8_t(Op::UV) && op != uint8_t(Op::Centered) &&
                      op != uint8_t(Op::PixelPos);
    for (uint8_t s = 0; s < operands && is_uniform; s++) {
      const uint8_t o = in[2 + s];
      if (!(o & kConstFlag) && !uniform_reg[o]) is_uniform = false;
    }
    uniform_reg[dst] = is_uniform;

    if (is_uniform) {
      uniform_[uniform_count_++] = uint8_t(i);
    } else {
      varying_[varying_count_++] = uint8_t(i);
      // A bilinear fetch is four texels and the lerps between them; everything else is
      // roughly one step. Rough on purpose: this only has to bound the work, not price it.
      // Uniform instructions are not counted: they are not what a pixel costs.
      const uint32_t fetch = (aux2 & 4) ? 8 : 1;
      if (op == uint8_t(Op::Tex)) {
        cost += fetch;
      } else if (op == uint8_t(Op::Anim)) {
        cost += (aux2 & 16) ? fetch * 2 : fetch;  // crossfade reads the frame either side
      } else if (op == uint8_t(Op::Particles)) {
        // The only loop in the VM, and the reason its trip count is clamped rather than
        // trusted: the budget has to be knowable before the first pixel is drawn.
        cost += particleCount(code_ + size_t(i) * format::kInstrSize) * (fetch + 8);
      } else {
        cost += 1;
      }
    }
  }

  // sample() returns the last instruction's register, so the program has to end by writing
  // the pixel. Anything else is a program that computes nothing.
  const uint8_t* last = code_ + size_t(instr_count_ - 1) * format::kInstrSize;
  if (last[0] != uint8_t(Op::Output)) {
    status_ = Status::BadProgram;
    return false;
  }
  result_reg_ = last[1];
  cost_ = cost;
  return true;
}

void ProtoShadeRuntime::unload() {
  blob_ = asset_table_ = nullptr;
  blob_len_ = 0;
  instr_count_ = 0;
  asset_count_ = prog_w_ = prog_h_ = const_count_ = 0;
  reg_count_ = sensor_count_ = 0;
  uniform_count_ = varying_count_ = 0;
  particle_emitters_ = particle_total_ = 0;
  result_reg_ = 0;
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
  aspect_ = float(width) / float(height);
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
  out.frames = assets_[index].frames;
  return true;
}

uint8_t ProtoShadeRuntime::particleCount(const uint8_t* in) const {
  const float n = consts_[in[4] & kOperandMask][0];
  if (!(n > 0.0f)) return 0;  // also catches NaN
  return n >= float(format::kMaxParticles) ? format::kMaxParticles : uint8_t(n);
}

// Every particle of every emitter, for this frame.
//
// Called once per core per frame, straight after the uniform instructions - which is the
// whole point. A particle's position, size, rotation and fade depend only on its index and
// the clock, so working them out here costs four sines per particle per frame instead of
// four sines per particle per PIXEL. On a 64x32 panel that is the difference between 24
// sines a frame and 98304 of them, on a chip whose sinf is software.
//
// The parameter block, five constants starting at the src2 operand:
//   0  count, life, fade, seed
//   1  direction deg, spread deg, speed, speed spread
//   2  acceleration (along the spawn direction), gravity x, gravity y, -
//   3  size, size spread, size rate, size acceleration
//   4  rotation deg, rotation spread deg, rotation rate deg/s, rotation acceleration deg/s2
void ProtoShadeRuntime::prepareParticles(ExecContext& ctx, const Frame& frame) const {
  (void)frame;
  for (uint8_t e = 0; e < particle_emitters_; e++) {
    const uint8_t idx = particle_instr_[e];
    const uint8_t* in = code_ + size_t(idx) * format::kInstrSize;
    const uint8_t n = particleCount(in);
    if (n == 0) continue;

    const uint8_t base = in[4] & kOperandMask;
    const float* emit = consts_[base];
    const float* motion = consts_[base + 1];
    const float* force = consts_[base + 2];
    const float* scale = consts_[base + 3];
    const float* spin = consts_[base + 4];

    // The clock. Validated at load to be a constant or a frame-uniform register, which is
    // what makes it safe to read once here rather than per pixel.
    const uint8_t o = in[3];
    const float t = (o & kConstFlag) ? consts_[o & kOperandMask][0] : ctx.regs[o][0];

    const float life = emit[1] > 0.0f ? emit[1] : 1.0f;
    const float inv_life = 1.0f / life;
    const float fade = clamp01(emit[2]);
    const float seed = emit[3] < 0.0f ? 0.0f : (emit[3] > 65535.0f ? 65535.0f : emit[3]);
    const uint16_t frames = assets_[in[6]].frames;
    Particle* out = ctx.particles + particle_base_[idx];

    for (uint8_t i = 0; i < n; i++) {
      // The odd-looking offset is not decoration: the finaliser maps 0 to 0, so particle 0
      // of seed 0 would come out with every random exactly zero - a particle frozen at the
      // emitter, in the one configuration somebody reaching for defaults will hit first.
      const uint32_t h0 = hashU32(uint32_t(i) * 0x9E3779B9U + uint32_t(seed) + 0x2545F491U);
      const uint32_t h1 = hashU32(h0);
      const uint32_t h2 = hashU32(h1);
      const uint32_t h3 = hashU32(h2);
      const uint32_t h4 = hashU32(h3);
      const uint32_t h5 = hashU32(h4);

      // Staggered by h0, so the whole swarm does not restart on the same frame.
      const float age = fract(t * inv_life + unitOf(h0));
      const float lived = age * life;

      // Spread is the full cone, so 360 really is all around and 0 is a straight line.
      const float dir = (motion[0] + (unitOf(h1) * 2.0f - 1.0f) * motion[1] * 0.5f) * kDegToRad;
      const float speed = motion[2] + (unitOf(h2) * 2.0f - 1.0f) * motion[3];
      float sd, cd;
      sinCos(dir, sd, cd);
      // 0 degrees is up the panel, and degrees go clockwise from there - which is what you
      // get by reading the widget as a compass bearing rather than as school trigonometry.
      const float dx = sd;
      const float dy = -cd;
      // Acceleration pushes along the spawn direction; gravity pushes the same way for all
      // of them. Both are constant, so the path is the schoolbook s = vt + at^2/2.
      const float ax = dx * force[0] + force[1];
      const float ay = dy * force[0] + force[2];
      out[i].x = dx * speed * lived + 0.5f * ax * lived * lived;
      out[i].y = dy * speed * lived + 0.5f * ay * lived * lived;

      const float size = scale[0] + (unitOf(h3) * 2.0f - 1.0f) * scale[1] + scale[2] * lived +
                         0.5f * scale[3] * lived * lived;
      const float rot = (spin[0] + (unitOf(h4) * 2.0f - 1.0f) * spin[1] * 0.5f + spin[2] * lived +
                         0.5f * spin[3] * lived * lived) *
                        kDegToRad;
      sinCos(rot, out[i].sin_r, out[i].cos_r);
      // A particle shrunk to nothing is skipped rather than divided by: alpha 0 is how the
      // pixel loop is told there is nothing here, and it already has that branch for fade.
      out[i].inv_scale = size > 0.0f ? 1.0f / size : 0.0f;
      out[i].alpha = size > 0.0f ? 1.0f - fade * age : 0.0f;
      out[i].frame = uint16_t(unitOf(h5) * float(frames));
    }
  }
}

void ProtoShadeRuntime::texel(uint16_t index, int32_t x, int32_t y, int32_t base, int32_t rows,
                              Wrap wrap, float* rgba) const {
  const AssetRef& a = assets_[index];
  const uint8_t* data = a.data;
  const size_t at =
      size_t(base + foldCoord(y, rows, wrap)) * size_t(a.w) + size_t(foldCoord(x, a.w, wrap));
  // Clip keeps the edge COLOUR but drops the alpha, so a linear fetch at the boundary fades
  // out instead of fading to black and leaving a dark fringe round the sprite.
  const bool clipped = wrap == Wrap::Clip && (x < 0 || y < 0 || x >= a.w || y >= rows);

  switch (a.format) {
    case AssetFormat::RGBA8888:
      for (int c = 0; c < 4; c++) rgba[c] = kOf255[data[at * 4 + c]];
      if (clipped) rgba[3] = 0.0f;
      break;
    case AssetFormat::A8:
      rgba[0] = rgba[1] = rgba[2] = 1.0f;
      rgba[3] = clipped ? 0.0f : kOf255[data[at]];
      break;
    default: {
      const uint16_t v = rd16(data + at * 2);
      rgba[0] = kOf31[(v >> 11) & 31];
      rgba[1] = kOf63[(v >> 5) & 63];
      rgba[2] = kOf31[v & 31];
      rgba[3] = clipped ? 0.0f : 1.0f;
      break;
    }
  }
}

void ProtoShadeRuntime::sampleFrame(uint16_t index, uint16_t frame, float u, float v,
                                    uint8_t flags, float* rgba) const {
  const AssetRef& a = assets_[index];
  const int32_t rows = a.rows;
  const int32_t base = int32_t(frame < a.frames ? frame : a.frames - 1) * rows;
  const Wrap wrap = Wrap(flags & 3);
  const float aw = float(a.w);
  const float ah = float(rows);

  if (!(flags & 4)) {
    texel(index, int32_t(std::floor(u * aw)), int32_t(std::floor(v * ah)), base, rows, wrap, rgba);
    return;
  }
  const float fx = u * aw - 0.5f;
  const float fy = v * ah - 0.5f;
  const int32_t x0 = int32_t(std::floor(fx));
  const int32_t y0 = int32_t(std::floor(fy));
  const float tx = fx - float(x0);
  const float ty = fy - float(y0);
  float p00[4], p10[4], p01[4], p11[4];
  texel(index, x0, y0, base, rows, wrap, p00);
  texel(index, x0 + 1, y0, base, rows, wrap, p10);
  texel(index, x0, y0 + 1, base, rows, wrap, p01);
  texel(index, x0 + 1, y0 + 1, base, rows, wrap, p11);
  for (int c = 0; c < 4; c++) {
    const float top = p00[c] + (p10[c] - p00[c]) * tx;
    const float bottom = p01[c] + (p11[c] - p01[c]) * tx;
    rgba[c] = top + (bottom - top) * ty;
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

void ProtoShadeRuntime::exec(ExecContext& ctx, const Frame& frame, uint16_t x, uint16_t y,
                             const uint8_t* list, uint16_t count) const {
  const float u = (float(x) + 0.5f) * inv_w_;
  const float v = (float(y) + 0.5f) * inv_h_;
  const float t = frame.seconds;

  // Operand -> the four floats it names. Validated at load, so no checks in here.
  auto src = [&](const uint8_t* in, int slot) -> const float* {
    const uint8_t o = in[2 + slot];
    return (o & kConstFlag) ? consts_[o & kOperandMask] : ctx.regs[o];
  };

  for (uint16_t n = 0; n < count; n++) {
    const uint8_t idx = list[n];
    const uint8_t* in = code_ + size_t(idx) * format::kInstrSize;
    const uint8_t aux = in[6];
    const uint8_t aux2 = in[7];
    float* dst = ctx.regs[in[1]];
    const float* a = src(in, 0);

    switch (Op(in[0])) {
      case Op::UV:
        dst[0] = u; dst[1] = v; dst[2] = 0.0f; dst[3] = 1.0f;
        break;
      case Op::Centered:
        // Aspect-corrected, so a circle on a 64x32 panel stays round.
        dst[0] = (u * 2.0f - 1.0f) * aspect_;
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
          //
          // The blend mode only applies where BOTH layers cover: over the part of the
          // foreground that hangs off the background there is nothing to multiply or add
          // with, so it stays its own colour. That is what the (1 - ab) term does, and it
          // is why "add" on two sprites brightens the overlap instead of turning the whole
          // foreground into a silhouette of itself.
          const float inv_alpha = 1.0f / alpha;
          for (int c = 0; c < 3; c++) {
            const float blended = (1.0f - ab) * fg[c] + ab * blendOp(aux, bg[c], fg[c]);
            dst[c] = (blended * af + bg[c] * ab * (1.0f - af)) * inv_alpha;
          }
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
        float rgba[4];
        // Frame 0 of the asset: a still is a one-frame strip, so this is the whole image.
        sampleFrame(aux, 0, a[0], a[1], aux2, rgba);
        if (aux2 & 8) {
          broadcast(dst, rgba[3]);
        } else {
          for (int c = 0; c < 4; c++) dst[c] = rgba[c];
        }
        break;
      }
      case Op::Anim: {
        const uint16_t frames = assets_[aux].frames;
        const float phase = src(in, 1)[0];
        // Two ways to read the phase, and they are the two things people want:
        //   loop  - phase is in whole cycles, and frac(phase) * frames walks the strip and
        //           starts over. Wire Time in and it is an animation.
        //   hold  - phase is 0..1 across the strip, clamped at both ends, so a sensor or a
        //           slider picks a frame. That is the blend-shape reading.
        // Either way the frame index is FLOORED to a frame that exists: interpolating the
        // phase picks between frames, it does not invent new ones. Turn crossfade on and
        // you get a dissolve between the two neighbours instead, which is a different
        // (and much more expensive) thing to want.
        float t;
        if (aux2 & 32) {
          t = fract(phase) * float(frames);
        } else {
          t = clamp01(phase) * float(frames - 1);
        }
        int32_t f0 = int32_t(t);
        if (f0 >= int32_t(frames)) f0 = int32_t(frames) - 1;  // frac() at its ceiling
        float rgba[4];
        sampleFrame(aux, uint16_t(f0), a[0], a[1], aux2, rgba);
        if (aux2 & 16) {
          const int32_t f1 = (aux2 & 32) ? (f0 + 1) % int32_t(frames)
                                         : (f0 + 1 < int32_t(frames) ? f0 + 1 : f0);
          const float k = t - float(f0);
          float next[4];
          sampleFrame(aux, uint16_t(f1), a[0], a[1], aux2, next);
          for (int c = 0; c < 4; c++) rgba[c] += (next[c] - rgba[c]) * k;
        }
        if (aux2 & 8) {
          broadcast(dst, rgba[3]);
        } else {
          for (int c = 0; c < 4; c++) dst[c] = rgba[c];
        }
        break;
      }
      case Op::Particles: {
        // A whole particle system in one instruction, and the only loop in the VM.
        //
        // Every particle was worked out for this frame by prepareParticles(); all that is
        // left per pixel is "where am I inside this sprite" - a subtract, a rotate, a scale
        // and a fetch. No trig, no hashing, no division.
        const uint8_t n = particleCount(in);
        const Particle* ps = ctx.particles + particle_base_[idx];
        dst[0] = dst[1] = dst[2] = dst[3] = 0.0f;
        // A pixel is inside a sprite or it is not, and most pixels are not: a swarm covers
        // a few texels each on a panel of thousands. Everything past the test below - the
        // texel fetches and the composite - was work whose answer was already "nothing".
        // One texel of slack on each side, because a bilinear fetch just outside 0..1 still
        // reaches the edge texel, and dropping that would eat the sprite's outline.
        const float mu = 1.0f / float(assets_[aux].w);
        const float mv = 1.0f / float(assets_[aux].rows);
        for (uint8_t i = 0; i < n; i++) {
          const Particle& p = ps[i];
          if (!(p.alpha > 0.0f)) continue;  // faded out, or scaled to nothing
          const float dx = a[0] - p.x;
          const float dy = a[1] - p.y;
          // Sprite-local coordinates, which the fetch needs anyway.
          const float su = (dx * p.cos_r + dy * p.sin_r) * p.inv_scale + 0.5f;
          const float sv = (dy * p.cos_r - dx * p.sin_r) * p.inv_scale + 0.5f;
          // Written as a rejection so a NaN coordinate falls out here rather than reaching
          // the sampler. Clip wrap would return alpha 0 for every one of these and the
          // composite below would then leave dst untouched, so skipping is not an
          // approximation - it is the same pixel, reached without the fetch.
          if (!(su > -mu && su < 1.0f + mu && sv > -mv && sv < 1.0f + mv)) continue;
          float rgba[4];
          // Clip: outside its own sprite a particle is transparent, never a tiled or
          // smeared copy - the one wrap mode that makes sense here, so it is not a knob.
          sampleFrame(aux, p.frame, su, sv, uint8_t((aux2 & 4) | uint8_t(Wrap::Clip)), rgba);
          overInto(dst, rgba, p.alpha);
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

}

// The per-pixel half. The uniform half must already have run into this same ExecContext,
// which is what renderRows() and sample() each arrange in their own way.
Pixel ProtoShadeRuntime::shade(ExecContext& ctx, const Frame& frame, uint16_t x, uint16_t y) const {
  // The ISA has no jumps, so the cost of a pixel is known before the first one is drawn:
  // one comparison replaces accounting inside the loop.
  ctx.steps_used = cost_;
  if (cost_ > ctx.step_limit) {
    ctx.budget_exceeded = true;
    return Pixel{0, 0, 0};
  }
  exec(ctx, frame, x, y, varying_, varying_count_);

  const float* out = ctx.regs[result_reg_];
  // Round, do not truncate: the preview does Math.round on the same floats, and half a
  // level of difference on every channel is exactly the kind of drift nobody would chase.
  // Output has already clamped to 0..1, so no negative can reach this.
  return Pixel{uint8_t(out[0] * 255.0f + 0.5f), uint8_t(out[1] * 255.0f + 0.5f),
               uint8_t(out[2] * 255.0f + 0.5f)};
}

Pixel ProtoShadeRuntime::sample(ExecContext& ctx, const Frame& frame, uint16_t x, uint16_t y) const {
  if (x >= w_ || y >= h_) return Pixel{0, 0, 0};
  if (status_ != Status::Ok) return testPattern(frame, x, y);

  // One pixel on its own pays for the uniform half too. renderRows() is the path that
  // amortises it, and it is the one every renderer actually uses.
  exec(ctx, frame, x, y, uniform_, uniform_count_);
  prepareParticles(ctx, frame);
  return shade(ctx, frame, x, y);
}

void ProtoShadeRuntime::renderRows(ExecContext& ctx, const Frame& frame, uint16_t y0, uint16_t y1,
                                   Pixel* dst) const {
  if (!dst || y0 >= y1 || y1 > h_) return;

  // Time, sensors and everything computed from them: once per core per frame, not once per
  // pixel. Each core has its own ExecContext, so each runs its own copy into its own
  // registers and the two never touch.
  const bool ready = status_ == Status::Ok;
  if (ready) {
    exec(ctx, frame, 0, 0, uniform_, uniform_count_);
    // Particle state for this frame, from the uniform registers that were just written.
    // Once per core per frame, next to the other work that does not vary across a frame.
    prepareParticles(ctx, frame);
  }

  for (uint16_t y = y0; y < y1; y++) {
    for (uint16_t x = 0; x < w_; x++) {
      *dst++ = ready ? shade(ctx, frame, x, y) : testPattern(frame, x, y);
    }
  }
}

}  // namespace protoshade
