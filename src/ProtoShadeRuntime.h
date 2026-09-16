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
  BadProgram,     // code is inside the blob but is not executable: bad opcode or operand
};

// Asset pixel formats. PNGs are decoded and converted by the web app at pack time - the
// device never decodes PNG, it just points at bytes.
enum class AssetFormat : uint8_t {
  RGB565 = 0,   // 2 bytes/px, what the packer emits for a fully opaque image
  RGBA8888 = 1, // 4 bytes/px, emitted as soon as one pixel is transparent
  A8 = 2,       // 1 byte/px, masks: reads as white with that alpha
};

// An asset is one image, or a strip of them: `frames` frames of height/frames rows each,
// stacked top to bottom. A still is just frames == 1, which is what a plain image packs as,
// so every sampler works in frame space and there is no second code path for stills.
struct Asset {
  const uint8_t* data;
  uint32_t length;
  uint16_t width, height;
  AssetFormat format;
  uint16_t frames;
};

// Sensor readings, by slot, exactly as the program's Sensor nodes indexed them. Borrowed:
// the array must outlive the Frame that carries it.
//
// They live in Frame rather than being read inside sample() because two cores render one
// frame at the same time. A reading that changed halfway through would put a different
// value in the top half of the face than the bottom, and you would see the seam.
// Plain members, no default initialisers: that keeps it an aggregate under -std=gnu++11,
// which the ESP32 Arduino core 2.x still compiles with, so Sensors{values, count} works
// there too. Fields you leave out of the braces are zero-initialised.
struct Sensors {
  const float* values;
  uint8_t count;
};

// Per-frame values, computed once and shared read-only by every core rendering that frame.
struct Frame {
  uint32_t ms;     // time base handed to the shader
  uint32_t index;  // frame counter, for effects that want it
  float seconds;   // ms in seconds, converted once here instead of once per pixel
  Sensors sensors;
};

namespace format {
constexpr uint8_t kMagic[4] = {'P', 'S', 'H', 'D'};
constexpr uint16_t kVersion = 5;       // bump on every layout change; old firmware then refuses new bins
constexpr size_t kHeaderSize = 48;
constexpr size_t kAssetEntrySize = 16;
constexpr size_t kInstrSize = 8;
constexpr uint16_t kMaxDimension = 512;  // sanity cap, not a hardware limit
constexpr uint8_t kMaxRegisters = 64;    // one per instruction; sized so the written-mask is one uint64_t
constexpr uint16_t kMaxConstants = 128;  // operand encoding is 7 bits + the constant flag
// Bounds on what load() will copy into RAM. Generous next to what the web app emits (it
// caps itself at kMaxRegisters instructions), and they are what keeps the copies below a
// few KB on a chip with 512 KB of SRAM.
constexpr uint16_t kMaxInstructions = 256;
constexpr uint16_t kMaxAssets = 32;
// Sprites one program may draw, across ALL its Particles instructions. It is the only loop
// in the VM, so this is what keeps "cost of a pixel" knowable: 64 sprites is 64 texel
// fetches, still well inside ExecContext::step_limit. It is also the size of the per-frame
// state table in ExecContext, which is why it is a budget for the program and not per
// instruction - two emitters share the 64 rather than each getting their own.
constexpr uint8_t kMaxParticles = 64;
// Constants one Particles instruction reads, starting at its src2 operand. Nineteen knobs
// do not fit in an eight-byte instruction, so the instruction points at a block in the
// constant pool instead. Mirrored by PARTICLE_QUADS in web/nodes.ts.
constexpr uint8_t kParticleQuads = 5;
}  // namespace format

// The instruction set. Mirrored in web/nodes.ts (OP) - the numbering IS the format, so
// append, never reorder, and bump kVersion when you do.
enum class Op : uint8_t {
  UV = 0,     // -> (u, v, 0, 1)
  Centered,   // aspect-corrected -1..1
  PixelPos,   // -> (x, y, 0, 1)
  Time,       // src0 = speed
  Sensor,     // aux = slot, aux2 = range << 1 | unit; src0 = value used when the slot is absent
  Math,       // aux = op index; src0 = A, src1 = B
  Mix,        // src0 = fac, src1 = A, src2 = B
  Over,       // aux = blend mode; src0 = fac, src1 = foreground, src2 = background
  Swizzle,    // aux = component 0..3, broadcast; src0 = vector
  Combine,    // src0..3 contribute their component 0
  Hsv,        // src0..3 = hue, sat, val, alpha
  Tex,        // aux = asset, aux2 = wrap | filter << 2 | alpha-out << 3; src0 = uv
  Output,     // src0 = colour, src1 = brightness. Always the last instruction.
  Anim,       // aux = asset, aux2 = tex flags | crossfade << 4 | loop << 5; src0 = uv, src1 = phase
  Particles,  // aux = asset, aux2 = filter << 2; src0 = position, src1 = time,
              // src2 = the FIRST of kParticleQuads consecutive constants (see ParticleParams)
  kCount,
};

constexpr uint8_t kMathOpCount = 21;  // web/nodes.ts MATH_OPS
constexpr uint8_t kRangeCount = 5;    // web/nodes.ts RANGES
constexpr uint8_t kBlendCount = 7;    // web/nodes.ts BLEND_MODES

// What a Tex instruction does outside the image (aux2 bits 0-1). web/nodes.ts WRAPS.
enum class Wrap : uint8_t {
  Repeat = 0,  // tiles
  Clamp = 1,   // the edge texel stretches outwards
  Clip = 2,    // transparent outside 0..1, so a sprite appears once and stops
  kCount,
};

// One particle, as the pixel loop needs it: where it is, how big, how turned, how faded.
//
// Worked out ONCE PER FRAME, not once per pixel. Everything in here comes from the particle's
// index and the clock, neither of which varies across a frame, and computing it per pixel
// would put four sines per particle inside the hottest loop in the firmware - on a chip where
// sinf is software. This struct is that decision made concrete.
struct Particle {
  float x, y;          // centre, in whatever space the position input is in
  float inv_scale;     // 1 / size, so the pixel loop multiplies
  float cos_r, sin_r;  // rotation, resolved here so no pixel ever calls a trig function
  float alpha;         // coverage after fade
  uint16_t frame;      // which frame of the sprite strip this one drew
  uint16_t reserved;
};

// Per-thread scratch. One per rendering thread - never share one across cores.
//
// A few KB because of the register file and the particle table, so keep it a member or a
// global, not a stack local inside loop(). That is also why it is caller-owned: the two
// render tasks each keep one.
struct ExecContext {
  // Hard ceiling on work per pixel. A program from the web is untrusted input: without a
  // budget a bad loop is a watchdog reset with the visor on someone's head. The code has no
  // loops, so today this is really a ceiling on program length - checked once per pixel.
  uint32_t step_limit = 4096;
  uint32_t steps_used = 0;   // reset per pixel
  bool budget_exceeded = false;  // sticky, so a frame can be flagged without checking per pixel

  float regs[format::kMaxRegisters][4] = {};
  // Filled by prepareParticles() once per frame, read by every pixel. Each Particles
  // instruction owns a slice, handed out at load().
  Particle particles[format::kMaxParticles] = {};
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
//   12      4     code_offset      instructions, 8 bytes each
//   16      4     code_length      in bytes; must be a multiple of 8
//   20      4     const_offset     constants, four float32 each
//   24      2     const_count
//   26      1     register_count
//   27      1     sensor_count     highest sensor slot the program uses, plus one
//   28      2     asset_count
//   30      2     reserved
//   32      4     asset_table_offset   asset_count entries of 16 bytes
//   36      4     total_length         must equal the blob length
//   40      8     reserved
//   48            end of header
//
// Asset table entry:
//   0       4     data_offset
//   4       4     data_length
//   8       2     width
//   10      2     height            the WHOLE strip; one frame is height / frames rows
//   12      1     format (AssetFormat)
//   13      2     frames            0 and 1 both mean "a still"; frames * (height/frames)
//                                   must fit in height, so a frame is always inside the blob
//   15      1     reserved
//
// Instruction (8 bytes): op, dst, src0, src1, src2, src3, aux, aux2.
// An operand byte is a register index, or a constant index with bit 7 set.
class ProtoShadeRuntime {
public:
  ProtoShadeRuntime() = default;
  ProtoShadeRuntime(uint16_t width, uint16_t height) { setResolution(width, height); }

  // Point the runtime at a compiled program. The ASSETS are not copied: on the ESP32 this is
  // meant to be a pointer into a flash partition mapped with esp_partition_mmap(), so a
  // megabyte of images costs no RAM. The caller must keep the data alive for as long as the
  // runtime uses it. The program itself - code, constants, asset headers - is small and is
  // copied into RAM here, see the members at the bottom for why.
  // Every offset, opcode and operand in the blob is validated here, so sampling never has to.
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

  uint16_t instructionCount() const { return instr_count_; }
  // How that splits: uniform instructions run once per core per frame, the rest run per
  // pixel. A shader whose animation comes only from time is mostly the first kind.
  uint16_t uniformInstructions() const { return uniform_count_; }
  uint16_t pixelInstructions() const { return varying_count_; }
  // Sensor slots the program reads. A head with fewer wired up still runs it: missing slots
  // read the value the author left in the Sensor node.
  uint8_t sensorCount() const { return sensor_count_; }

  Frame beginFrame(uint32_t ms) const { return beginFrame(ms, Sensors{}); }
  Frame beginFrame(uint32_t ms, const Sensors& sensors) const {
    return Frame{ms, frame_index_++, float(ms) / 1000.0f, sensors};
  }

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
  bool validateCode();
  // Runs the instructions named by `list`. One interpreter, two passes: the frame-uniform
  // one and the per-pixel one.
  void exec(ExecContext& ctx, const Frame& frame, uint16_t x, uint16_t y, const uint8_t* list,
            uint16_t count) const;
  // Per-pixel pass only. Valid once the uniform pass has run into the same ExecContext.
  Pixel shade(ExecContext& ctx, const Frame& frame, uint16_t x, uint16_t y) const;
  // Reads one texel of one FRAME into rgba (0..1). Coordinates are frame-local: y runs
  // 0..rows(frame)-1, and `base` is the row that frame starts at. Bounds are already
  // validated at load().
  void texel(uint16_t asset, int32_t x, int32_t y, int32_t base, int32_t rows, Wrap wrap,
             float* rgba) const;
  // One frame of one asset, sampled at (u, v) in 0..1 of that frame. flags are the Tex
  // flags: wrap in bits 0-1, bilinear in bit 2. Tex, Anim and Particles all come through
  // here, so there is exactly one bilinear fetch in the VM.
  void sampleFrame(uint16_t asset, uint16_t frame, float u, float v, uint8_t flags,
                   float* rgba) const;
  // Sprites a Particles instruction draws, clamped to what is left of the program's budget.
  // Its operand is required to be a constant (validateCode enforces it), so this is known at
  // load - which is what keeps the per-pixel budget a number rather than a guess.
  uint8_t particleCount(const uint8_t* instruction) const;
  // Works out every particle of every Particles instruction for this frame, into ctx. Runs
  // once per core per frame, right after the uniform instructions that feed it.
  void prepareParticles(ExecContext& ctx, const Frame& frame) const;

  // Asset header, copied out of the blob at load. Four fields the sampler needs per texel,
  // in RAM, instead of re-parsing a 16-byte table entry out of mapped flash every time.
  struct AssetRef {
    const uint8_t* data;
    int32_t w, h;
    AssetFormat format;
    uint16_t frames;
    int32_t rows;  // h / frames, precomputed: the one integer divide a texel fetch would cost
  };

  const uint8_t* blob_ = nullptr;
  size_t blob_len_ = 0;
  const uint8_t* asset_table_ = nullptr;
  uint16_t instr_count_ = 0;
  uint16_t asset_count_ = 0;
  uint16_t prog_w_ = 0, prog_h_ = 0;
  uint8_t reg_count_ = 0;
  uint8_t sensor_count_ = 0;

  // Code, constants and asset headers are copied into RAM at load.
  //
  // On the ESP32 the blob is mapped flash: every read goes through the 32 KB cache, which
  // the framebuffer and the assets are already competing for. The program is at most 2 KB,
  // so copying it buys a hot loop that never misses, and constants stop being reassembled
  // from unaligned bytes on every single pixel. The assets stay mapped - they are the big
  // thing, and the whole point of mmap is that they cost no RAM.
  uint8_t code_[format::kMaxInstructions * format::kInstrSize] = {};
  float consts_[format::kMaxConstants][4] = {};
  AssetRef assets_[format::kMaxAssets] = {};
  uint16_t const_count_ = 0;

  // Instruction indices split by what they depend on.
  //
  // Anything not derived from the pixel position - time, sensors, constants, and everything
  // computed from those - has the same value for every pixel in a frame, so it runs once per
  // core per frame instead of once per pixel. A shader that drives a sine from time alone
  // was paying for that sine on every one of 4096 pixels; now it pays twice a frame.
  //
  // Safe only because every register is written exactly once (validateCode proves it), so
  // pulling those instructions out cannot change what anything downstream reads.
  uint8_t uniform_[format::kMaxInstructions] = {};
  uint8_t varying_[format::kMaxInstructions] = {};
  uint16_t uniform_count_ = 0;
  uint16_t varying_count_ = 0;
  uint8_t result_reg_ = 0;  // where the Output instruction leaves the pixel

  // Where each instruction's slice of ExecContext::particles starts, by instruction index,
  // and the list of which instructions are emitters at all. Both worked out at load, so the
  // frame setup knows what to fill and the pixel loop knows what to read without looking.
  uint8_t particle_base_[format::kMaxInstructions] = {};
  uint8_t particle_instr_[format::kMaxParticles] = {};
  uint8_t particle_emitters_ = 0;
  uint8_t particle_total_ = 0;

  // Work one PIXEL costs, which is the varying half. The ISA has no jumps, so this is known
  // before rendering starts.
  uint32_t cost_ = 0;

  uint16_t w_ = 8, h_ = 8;
  // Reciprocals, so the per-pixel coordinate is a multiply. The S3 has a single-precision
  // FPU with no divide worth the name; this is the one division that would run per pixel.
  float inv_w_ = 1.0f / 8.0f, inv_h_ = 1.0f / 8.0f;
  mutable uint32_t frame_index_ = 0;  // only touched by beginFrame(), never while rendering
  Status status_ = Status::NoProgram;
};

}  // namespace protoshade
