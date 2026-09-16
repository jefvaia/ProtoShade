// Runtime self-check: container validation, then the VM itself.
//
//   g++ -std=c++17 test/test.cpp src/ProtoShadeRuntime.cpp -o /tmp/t && /tmp/t
//   (build.bat runs the same file through em++ before building the wasm module)
//
// Containers are built here byte by byte rather than by calling the packer, so this file is
// the arbiter if web/pack.ts and the runtime ever disagree about the format. What the two
// sides do with a *graph* is a different question, and test/crosscheck.mjs answers it by
// rendering the same program through the TypeScript interpreter and this VM.

#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstdlib>  // std::abs(int); libc++ does not hand it over via <cmath>
#include <cstring>
#include <vector>

#include "../src/ProtoShadeDisplay.h"
#include "../src/ProtoShadeRuntime.h"

using namespace protoshade;

namespace {

void put16(std::vector<uint8_t>& v, size_t at, uint16_t x) {
  v[at] = x & 0xFF;
  v[at + 1] = x >> 8;
}
void put32(std::vector<uint8_t>& v, size_t at, uint32_t x) {
  for (int i = 0; i < 4; i++) v[at + i] = (x >> (8 * i)) & 0xFF;
}

constexpr uint8_t kConst = 0x80;

struct AssetSpec {
  uint16_t w, h;
  AssetFormat format;
  std::vector<uint8_t> data;
  uint16_t frames = 1;  // h / frames rows per frame; 1 is a still
};

// Builds a container the way the web app does: pool a constant, emit an instruction, ship.
struct Builder {
  std::vector<uint8_t> code;
  std::vector<float> consts;
  std::vector<AssetSpec> assets;
  uint8_t regs = 0;
  uint8_t sensors = 0;

  uint8_t konst(float r, float g, float b, float a) {
    consts.insert(consts.end(), {r, g, b, a});
    return uint8_t(kConst | (consts.size() / 4 - 1));
  }
  uint8_t scalar(float x) { return konst(x, x, x, 1.0f); }

  uint8_t emit(Op op, uint8_t s0 = 0, uint8_t s1 = 0, uint8_t s2 = 0, uint8_t s3 = 0, uint8_t aux = 0,
               uint8_t aux2 = 0) {
    const uint8_t dst = regs++;
    for (uint8_t b : {uint8_t(op), dst, s0, s1, s2, s3, aux, aux2}) code.push_back(b);
    return dst;
  }

  uint16_t addAsset(AssetSpec a) {
    assets.push_back(std::move(a));
    return uint16_t(assets.size() - 1);
  }

  std::vector<uint8_t> blob() const {
    const uint32_t const_off = format::kHeaderSize;
    const uint32_t code_off = const_off + uint32_t(consts.size()) * 4;
    const uint32_t table_off = code_off + uint32_t(code.size());
    const uint32_t data_off = table_off + uint32_t(assets.size() * format::kAssetEntrySize);
    uint32_t total = data_off;
    for (const AssetSpec& a : assets) total += uint32_t(a.data.size());

    std::vector<uint8_t> v(total, 0);
    std::memcpy(v.data(), format::kMagic, 4);
    put16(v, 4, format::kVersion);
    put16(v, 6, 0);    // flags
    put16(v, 8, 64);   // width hint
    put16(v, 10, 32);  // height hint
    put32(v, 12, code_off);
    put32(v, 16, uint32_t(code.size()));
    put32(v, 20, const_off);
    put16(v, 24, uint16_t(consts.size() / 4));
    v[26] = regs;
    v[27] = sensors;
    put16(v, 28, uint16_t(assets.size()));
    put32(v, 32, table_off);
    put32(v, 36, total);

    for (size_t i = 0; i < consts.size(); i++) {
      uint32_t bits = 0;
      const float f = consts[i];
      std::memcpy(&bits, &f, 4);
      put32(v, const_off + i * 4, bits);
    }
    if (!code.empty()) std::memcpy(v.data() + code_off, code.data(), code.size());

    uint32_t at = data_off;
    for (size_t i = 0; i < assets.size(); i++) {
      const size_t e = table_off + i * format::kAssetEntrySize;
      put32(v, e, at);
      put32(v, e + 4, uint32_t(assets[i].data.size()));
      put16(v, e + 8, assets[i].w);
      put16(v, e + 10, assets[i].h);
      v[e + 12] = uint8_t(assets[i].format);
      put16(v, e + 13, assets[i].frames);
      std::memcpy(v.data() + at, assets[i].data.data(), assets[i].data.size());
      at += uint32_t(assets[i].data.size());
    }
    return v;
  }
};

/** The smallest valid program: a flat colour straight into the output. */
Builder flatColour(float r, float g, float b, float a = 1.0f, float brightness = 1.0f) {
  Builder p;
  const uint8_t c = p.konst(r, g, b, a);
  p.emit(Op::Output, c, p.scalar(brightness));
  return p;
}

bool near(uint8_t got, int want) { return std::abs(int(got) - want) <= 1; }

Pixel renderOne(const std::vector<uint8_t>& blob, uint16_t x = 0, uint16_t y = 0, uint32_t ms = 0,
                uint16_t w = 4, uint16_t h = 4, const Sensors& sensors = Sensors{}) {
  ProtoShadeRuntime rt(w, h);
  assert(rt.load(blob.data(), blob.size()));
  ExecContext ctx;
  return rt.sample(ctx, rt.beginFrame(ms, sensors), x, y);
}

void testLoadRejectsGarbage() {
  ProtoShadeRuntime rt;
  assert(rt.status() == Status::NoProgram);
  assert(!rt.hasProgram());

  assert(!rt.load(nullptr, 0));
  assert(rt.status() == Status::TooSmall);

  auto blob = flatColour(1, 0, 0).blob();
  assert(!rt.load(blob.data(), format::kHeaderSize - 1));
  assert(rt.status() == Status::TooSmall);

  auto bad_magic = blob;
  bad_magic[1] = 'X';
  assert(!rt.load(bad_magic.data(), bad_magic.size()));
  assert(rt.status() == Status::BadMagic);

  // A bin from a newer web app must be refused, not misread.
  auto bad_ver = blob;
  put16(bad_ver, 4, format::kVersion + 1);
  assert(!rt.load(bad_ver.data(), bad_ver.size()));
  assert(rt.status() == Status::BadVersion);

  // Code span running past the end of the blob.
  auto bad_code = blob;
  put32(bad_code, 16, 0xFFF0);
  assert(!rt.load(bad_code.data(), bad_code.size()));
  assert(rt.status() == Status::BadLayout);

  // Code length that is not a whole number of instructions.
  auto ragged = blob;
  put32(ragged, 16, 7);
  assert(!rt.load(ragged.data(), ragged.size()));
  assert(rt.status() == Status::BadLayout);

  // Offset large enough to overflow a 32-bit add: must not wrap into "inside the blob".
  auto overflow = blob;
  put32(overflow, 12, 0xFFFFFFF0);
  put32(overflow, 16, 0x20);
  assert(!rt.load(overflow.data(), overflow.size()));
  assert(rt.status() == Status::BadLayout);

  // Truncated file: declared total_length no longer matches what was handed over.
  assert(!rt.load(blob.data(), blob.size() - 1));
  assert(rt.status() == Status::BadLayout);

  // More registers or constants than the device has room for.
  auto too_many_regs = blob;
  too_many_regs[26] = format::kMaxRegisters + 1;
  assert(!rt.load(too_many_regs.data(), too_many_regs.size()));
  assert(rt.status() == Status::BadProgram);
}

void testAssetValidation() {
  ProtoShadeRuntime rt;
  Builder p = flatColour(0, 0, 0);
  p.addAsset({2, 1, AssetFormat::RGB565, {0, 0, 0, 0}});
  auto blob = p.blob();
  assert(rt.load(blob.data(), blob.size()));

  Asset a{};
  assert(rt.asset(0, a) && a.width == 2 && a.height == 1 && a.format == AssetFormat::RGB565);
  assert(!rt.asset(1, a));

  // An asset pointing outside the blob.
  auto bad = blob;
  const uint32_t table = 0x20;  // header offset of asset_table_offset
  const uint32_t table_off = uint32_t(bad[table]) | uint32_t(bad[table + 1]) << 8;
  put32(bad, table_off, 0xFFF0);
  assert(!rt.load(bad.data(), bad.size()));
  assert(rt.status() == Status::BadLayout);

  // Dimensions that need more bytes than the asset actually has: the shader indexes texels
  // without re-checking, so this has to be caught here.
  auto short_data = blob;
  put16(short_data, table_off + 8, 64);
  assert(!rt.load(short_data.data(), short_data.size()));
  assert(rt.status() == Status::BadLayout);
}

void testCodeValidation() {
  ProtoShadeRuntime rt;

  // Unknown opcode.
  {
    Builder p = flatColour(1, 1, 1);
    p.code[0] = uint8_t(Op::kCount);
    auto b = p.blob();
    assert(!rt.load(b.data(), b.size()) && rt.status() == Status::BadProgram);
  }
  // Operand naming a register nothing has written yet.
  {
    Builder p;
    p.emit(Op::Output, 3, p.scalar(1));  // register 3 is never written
    auto b = p.blob();
    assert(!rt.load(b.data(), b.size()) && rt.status() == Status::BadProgram);
  }
  // Constant index past the end of the pool.
  {
    Builder p = flatColour(1, 1, 1);
    p.code[2] = kConst | 60;
    auto b = p.blob();
    assert(!rt.load(b.data(), b.size()) && rt.status() == Status::BadProgram);
  }
  // Math op index that does not exist.
  {
    Builder p;
    const uint8_t m = p.emit(Op::Math, p.scalar(1), p.scalar(1), 0, 0, kMathOpCount);
    p.emit(Op::Output, m, p.scalar(1));
    auto b = p.blob();
    assert(!rt.load(b.data(), b.size()) && rt.status() == Status::BadProgram);
  }
  // Texture instruction naming an asset that was not packed.
  {
    Builder p;
    const uint8_t uv = p.emit(Op::UV);
    const uint8_t t = p.emit(Op::Tex, uv, 0, 0, 0, 0);
    p.emit(Op::Output, t, p.scalar(1));
    auto b = p.blob();
    assert(!rt.load(b.data(), b.size()) && rt.status() == Status::BadProgram);
  }
  // A program that never writes a pixel.
  {
    Builder p;
    p.emit(Op::UV);
    auto b = p.blob();
    assert(!rt.load(b.data(), b.size()) && rt.status() == Status::BadProgram);
  }
  // Empty code.
  {
    Builder p;
    p.regs = 1;
    auto b = p.blob();
    assert(!rt.load(b.data(), b.size()) && rt.status() == Status::BadProgram);
  }
}

void testResolution() {
  ProtoShadeRuntime rt(64, 32);
  assert(rt.width() == 64 && rt.height() == 32);
  assert(!rt.setResolution(0, 32));
  assert(!rt.setResolution(64, 0));
  assert(!rt.setResolution(format::kMaxDimension + 1, 32));
  assert(rt.width() == 64 && rt.height() == 32);  // rejected changes nothing
  assert(rt.setResolution(1, 1));
}

void testNoProgramFallsBackToPattern() {
  ProtoShadeRuntime rt(8, 8);
  ExecContext ctx;
  const Frame f0 = rt.beginFrame(0);
  assert(rt.sample(ctx, f0, 0, 0).g == 0);
  assert(rt.sample(ctx, rt.beginFrame(256), 0, 0).g == 128);
  assert(rt.sample(ctx, f0, 1, 0).g == rt.sample(ctx, f0, 0, 1).g);  // diagonal symmetry

  const Pixel oob = rt.sample(ctx, f0, 99, 99);
  assert(oob.r == 0 && oob.g == 0 && oob.b == 0);

  // beginFrame hands out increasing frame indices. Sequenced into locals on purpose:
  // the evaluation order of the two operands of < is unspecified.
  const uint32_t first = rt.beginFrame(0).index;
  const uint32_t second = rt.beginFrame(0).index;
  assert(second == first + 1);
}

void testOutput() {
  // Flat colour, brightness, and alpha flattening against black.
  assert(renderOne(flatColour(1, 0.5f, 0).blob()).r == 255);
  assert(near(renderOne(flatColour(1, 0.5f, 0).blob()).g, 128));
  assert(renderOne(flatColour(1, 1, 1, 1.0f, 0.5f).blob()).r == 128);
  assert(near(renderOne(flatColour(1, 0, 0, 0.5f).blob()).r, 128));
  // Out of gamut is clamped, not wrapped: 2.0 is white, not black.
  assert(renderOne(flatColour(2, 2, 2).blob()).r == 255);
  assert(renderOne(flatColour(-1, -1, -1).blob()).r == 0);
}

void testCoordinateOps() {
  // UV: pixel centres, so on a 4-wide panel column 0 is 0.125.
  Builder uv;
  uv.emit(Op::Output, uv.emit(Op::UV), uv.scalar(1));
  assert(near(renderOne(uv.blob(), 0, 0).r, 32));   // 0.125 * 255
  assert(near(renderOne(uv.blob(), 3, 0).r, 223));  // 0.875 * 255

  // Pixel: raw coordinates, so anything past 1 clamps to white at the output.
  Builder px;
  px.emit(Op::Output, px.emit(Op::PixelPos), px.scalar(1));
  assert(renderOne(px.blob(), 0, 0).r == 0);
  assert(renderOne(px.blob(), 2, 0).r == 255);

  // Centered is aspect-corrected: on 4x2 the x span is twice the y span.
  Builder c;
  c.emit(Op::Output, c.emit(Op::Centered), c.scalar(1));
  const Pixel right = renderOne(c.blob(), 3, 0, 0, 4, 2);
  assert(right.r == 255);  // 0.875 * 2 - 1 = 0.75, times aspect 2 = 1.5 -> clamped
}

void testMathAndSwizzle() {
  // modulo is floored, so a negative coordinate wraps instead of tearing.
  Builder m;
  const uint8_t r = m.emit(Op::Math, m.scalar(-0.25f), m.scalar(1), 0, 0, 5);
  m.emit(Op::Output, r, m.scalar(1));
  assert(near(renderOne(m.blob()).r, 191));  // 0.75

  // divide by zero is 0, not inf: an inf here would render as a black hole.
  Builder d;
  d.emit(Op::Output, d.emit(Op::Math, d.scalar(1), d.scalar(0), 0, 0, 3), d.scalar(1));
  assert(renderOne(d.blob()).r == 0);

  // Alpha rides through from A, so multiplying a colour cannot change its coverage.
  Builder a;
  const uint8_t half = a.konst(1, 1, 1, 0.5f);
  a.emit(Op::Output, a.emit(Op::Math, half, a.scalar(1), 0, 0, 2), a.scalar(1));
  assert(near(renderOne(a.blob()).r, 128));

  // Swizzle broadcasts one component and comes back opaque.
  Builder s;
  const uint8_t v = s.konst(0.25f, 0.5f, 0.75f, 0.0f);
  s.emit(Op::Output, s.emit(Op::Swizzle, v, 0, 0, 0, 2), s.scalar(1));
  assert(near(renderOne(s.blob()).r, 191));  // component 2, and alpha 1 despite the 0 above
}

void testCombineMixOverHsv() {
  Builder c;
  c.emit(Op::Output, c.emit(Op::Combine, c.scalar(1), c.scalar(0), c.scalar(0.5f), c.scalar(1)),
         c.scalar(1));
  const Pixel combined = renderOne(c.blob());
  assert(combined.r == 255 && combined.g == 0 && near(combined.b, 128));

  Builder m;
  m.emit(Op::Output, m.emit(Op::Mix, m.scalar(0.25f), m.scalar(0), m.scalar(1)), m.scalar(1));
  assert(near(renderOne(m.blob()).r, 64));

  // Half-transparent red over opaque blue.
  Builder o;
  const uint8_t fg = o.konst(1, 0, 0, 0.5f);
  const uint8_t bg = o.konst(0, 0, 1, 1.0f);
  o.emit(Op::Output, o.emit(Op::Over, o.scalar(1), fg, bg), o.scalar(1));
  const Pixel over = renderOne(o.blob());
  assert(near(over.r, 128) && over.g == 0 && near(over.b, 128));

  // Hue 1/3 is green; hue wraps, so 4/3 is the same green.
  Builder h;
  h.emit(Op::Output, h.emit(Op::Hsv, h.scalar(1.0f / 3.0f), h.scalar(1), h.scalar(1), h.scalar(1)),
         h.scalar(1));
  const Pixel green = renderOne(h.blob());
  assert(green.r == 0 && green.g == 255 && green.b == 0);

  Builder h2;
  h2.emit(Op::Output, h2.emit(Op::Hsv, h2.scalar(4.0f / 3.0f), h2.scalar(1), h2.scalar(1), h2.scalar(1)),
          h2.scalar(1));
  const Pixel wrapped = renderOne(h2.blob());
  assert(wrapped.r == green.r && wrapped.g == green.g && wrapped.b == green.b);
}

void testTimeAndSensors() {
  Builder t;
  t.emit(Op::Output, t.emit(Op::Time, t.scalar(0.5f)), t.scalar(1));
  assert(renderOne(t.blob(), 0, 0, 0).r == 0);
  assert(near(renderOne(t.blob(), 0, 0, 1000).r, 128));  // 1s * 0.5

  // Slot 0, unit output, "0..inf": 3 saturates to 0.75 instead of clipping to white.
  Builder s;
  s.sensors = 1;
  s.emit(Op::Output, s.emit(Op::Sensor, s.scalar(3.0f), 0, 0, 0, 0, uint8_t((2 << 1) | 1)), s.scalar(1));
  assert(near(renderOne(s.blob()).r, 191));

  // A live reading replaces the value baked into the program...
  const float feed[1] = {1.0f};
  Sensors live{feed, 1};
  assert(near(renderOne(s.blob(), 0, 0, 0, 4, 4, live).r, 128));  // 1/(1+1)

  // ...but a head with fewer sensors than the program expects still runs it.
  Builder s2;
  s2.sensors = 4;
  s2.emit(Op::Output, s2.emit(Op::Sensor, s2.scalar(0.25f), 0, 0, 0, 3, 0), s2.scalar(1));
  assert(near(renderOne(s2.blob(), 0, 0, 0, 4, 4, live).r, 64));  // slot 3 absent -> 0.25
}

void testTexture() {
  // 2x1 RGB565: red, blue.
  const uint16_t red = 0xF800, blue = 0x001F;
  AssetSpec a{2, 1, AssetFormat::RGB565,
              {uint8_t(red & 0xFF), uint8_t(red >> 8), uint8_t(blue & 0xFF), uint8_t(blue >> 8)}};

  Builder p;
  p.addAsset(a);
  const uint8_t uv = p.emit(Op::UV);
  p.emit(Op::Output, p.emit(Op::Tex, uv, 0, 0, 0, 0, 0), p.scalar(1));
  auto blob = p.blob();
  const Pixel left = renderOne(blob, 0, 0, 0, 4, 1);
  const Pixel right = renderOne(blob, 3, 0, 0, 4, 1);
  assert(left.r == 255 && left.b == 0);
  assert(right.b == 255 && right.r == 0);

  // clip: outside 0..1 the image is transparent, so a sprite placed with scaled UV appears
  // once instead of smearing its edge texel across the rest of the panel.
  //
  // Only the horizontal axis is scaled here. Multiplying the whole UV scales v as well,
  // which on a one-row panel walks straight off the bottom of the image - which is itself
  // half of why a scaled sprite looks wrong.
  auto scaledU = [&](Builder& p, uint8_t times) {
    const uint8_t uv = p.emit(Op::UV);
    const uint8_t u = p.emit(Op::Swizzle, uv, 0, 0, 0, 0);          // broadcast u
    const uint8_t sx = p.emit(Op::Math, u, p.scalar(float(times)), 0, 0, 2);
    return p.emit(Op::Combine, sx, p.scalar(0.25f), p.scalar(0), p.scalar(1));
  };

  Builder clip;
  clip.addAsset(a);
  clip.emit(Op::Output, clip.emit(Op::Tex, scaledU(clip, 4), 0, 0, 0, 0, uint8_t(Wrap::Clip)),
            clip.scalar(1));
  auto clip_blob = clip.blob();
  assert(renderOne(clip_blob, 0, 0, 0, 8, 1).r == 255);  // u*4 = 0.25 -> inside, red
  const Pixel outside = renderOne(clip_blob, 6, 0, 0, 8, 1);
  assert(outside.r == 0 && outside.g == 0 && outside.b == 0);  // u*4 = 3.25 -> nothing

  // clamp instead smears that same edge texel across everything to the right, which is the
  // whole difference between the two.
  Builder clamped;
  clamped.addAsset(a);
  clamped.emit(Op::Output,
               clamped.emit(Op::Tex, scaledU(clamped, 4), 0, 0, 0, 0, uint8_t(Wrap::Clamp)),
               clamped.scalar(1));
  assert(renderOne(clamped.blob(), 6, 0, 0, 8, 1).b == 255);  // the last texel, stretched

  // repeat tiles it instead.
  Builder repeated;
  repeated.addAsset(a);
  repeated.emit(Op::Output,
                repeated.emit(Op::Tex, scaledU(repeated, 4), 0, 0, 0, 0, uint8_t(Wrap::Repeat)),
                repeated.scalar(1));
  assert(renderOne(repeated.blob(), 4, 0, 0, 8, 1).r == 255);  // u*4 = 2.25 -> back to red

  // An out-of-range wrap mode is refused at load, not run.
  Builder bad;
  bad.addAsset(a);
  const uint8_t buv = bad.emit(Op::UV);
  bad.emit(Op::Output, bad.emit(Op::Tex, buv, 0, 0, 0, 0, uint8_t(Wrap::kCount)), bad.scalar(1));
  auto bad_blob = bad.blob();
  ProtoShadeRuntime rt;
  assert(!rt.load(bad_blob.data(), bad_blob.size()) && rt.status() == Status::BadProgram);

  // RGBA8888 keeps its alpha, and the output flattens it against black.
  AssetSpec rgba{1, 1, AssetFormat::RGBA8888, {255, 255, 255, 128}};
  Builder q;
  q.addAsset(rgba);
  const uint8_t quv = q.emit(Op::UV);
  q.emit(Op::Output, q.emit(Op::Tex, quv, 0, 0, 0, 0, 0), q.scalar(1));
  assert(near(renderOne(q.blob()).r, 128));

  // The alpha output is that same coverage as a plain number.
  Builder r;
  r.addAsset(rgba);
  const uint8_t ruv = r.emit(Op::UV);
  r.emit(Op::Output, r.emit(Op::Tex, ruv, 0, 0, 0, 0, 8), r.scalar(1));
  assert(near(renderOne(r.blob()).r, 128));
}

// A strip of frames, indexed by a phase. The point of the op is that a phase between two
// frames picks ONE OF THEM - it does not invent an image nobody drew - unless crossfade is
// asked for explicitly.
void testAnimation() {
  // Four frames, one row each: red, green, blue, white.
  std::vector<uint8_t> rows;
  for (uint16_t v : {0xF800, 0x07E0, 0x001F, 0xFFFF}) {
    rows.push_back(uint8_t(v & 0xFF));
    rows.push_back(uint8_t(v >> 8));
  }
  const AssetSpec strip{1, 4, AssetFormat::RGB565, rows, 4};

  // flags: clamp wrap, plus whatever the case is testing. A 1x1 panel samples the middle of
  // whichever frame the phase picks.
  auto frameAt = [&](float phase, uint8_t flags) {
    Builder p;
    p.addAsset(strip);
    const uint8_t uv = p.emit(Op::UV);
    p.emit(Op::Output, p.emit(Op::Anim, uv, p.scalar(phase), 0, 0, 0, uint8_t(1 | flags)), p.scalar(1));
    return renderOne(p.blob(), 0, 0, 0, 1, 1);
  };

  // Hold: 0..1 spans the strip and stops at both ends. This is the blend-shape reading.
  assert(frameAt(0.0f, 0).r == 255 && frameAt(0.0f, 0).g == 0);       // frame 0, red
  assert(frameAt(1.0f, 0).r == 255 && frameAt(1.0f, 0).b == 255);     // frame 3, white
  assert(frameAt(2.0f, 0).b == 255);                                  // past the end, held
  const Pixel middle = frameAt(0.4f, 0);  // 0.4 * 3 = 1.2 -> frame 1
  assert(middle.g == 255 && middle.r == 0 && middle.b == 0);          // green, NOT a blend

  // Loop: the phase counts whole cycles and wraps. This is the animation reading.
  assert(frameAt(0.3f, 32).g == 255);   // 0.3 * 4 = 1.2 -> frame 1
  assert(frameAt(1.3f, 32).g == 255);   // a cycle later, the same frame
  assert(frameAt(0.9f, 32).b == 255 && frameAt(0.9f, 32).r == 255);  // 3.6 -> frame 3

  // Crossfade is the one way to get an image that is not in the strip: halfway between
  // frame 1 and frame 2 is half green, half blue.
  const Pixel blend = frameAt(0.5f, 16);  // 0.5 * 3 = 1.5
  assert(near(blend.g, 128) && near(blend.b, 128) && blend.r == 0);

  // More frames than rows would leave a frame with no pixels in it.
  Builder bad;
  bad.addAsset({1, 4, AssetFormat::RGB565, rows, 5});
  const uint8_t buv = bad.emit(Op::UV);
  bad.emit(Op::Output, bad.emit(Op::Anim, buv, bad.scalar(0), 0, 0, 0, 1), bad.scalar(1));
  auto bad_blob = bad.blob();
  ProtoShadeRuntime rt;
  assert(!rt.load(bad_blob.data(), bad_blob.size()) && rt.status() == Status::BadLayout);
}

// The one loop in the VM. Its trip count comes from a constant so the cost of a pixel stays
// knowable at load, which is what the step budget is built on.
void testParticles() {
  const AssetSpec dot{1, 1, AssetFormat::RGBA8888, {255, 255, 255, 255}};

  auto build = [&](uint8_t count_operand_is_const, float count) {
    Builder p;
    p.addAsset(dot);
    const uint8_t pos = p.emit(Op::Centered);
    const uint8_t pa = p.konst(count, 1.0f, 0.0f, 0.0f);  // count, size, speed, spread
    const uint8_t pb = p.konst(0.0f, 0.0f, 1.0f, 0.0f);   // gravity, seed, life, fade
    const uint8_t src2 = count_operand_is_const ? pa : p.emit(Op::Time, p.scalar(0));
    p.emit(Op::Output, p.emit(Op::Particles, pos, p.scalar(0), src2, pb, 0, 0), p.scalar(1));
    return p.blob();
  };

  // One still particle, a sprite as wide as the space: the middle pixel is covered.
  assert(renderOne(build(1, 1.0f), 0, 0, 0, 1, 1).r == 255);
  // No particles is transparent, which the output flattens to black.
  assert(renderOne(build(1, 0.0f), 0, 0, 0, 1, 1).r == 0);

  // A count that is not a constant could be anything by the time the pixel runs, so the
  // budget could not be proven at load. Refused there rather than clamped at run time.
  {
    auto blob = build(0, 1.0f);
    ProtoShadeRuntime rt;
    assert(!rt.load(blob.data(), blob.size()) && rt.status() == Status::BadProgram);
  }
  // An asset index that was never packed.
  {
    Builder p;
    const uint8_t pos = p.emit(Op::Centered);
    p.emit(Op::Output,
           p.emit(Op::Particles, pos, p.scalar(0), p.konst(1, 1, 0, 0), p.konst(0, 0, 1, 0), 0, 0),
           p.scalar(1));
    auto blob = p.blob();
    ProtoShadeRuntime rt;
    assert(!rt.load(blob.data(), blob.size()) && rt.status() == Status::BadProgram);
  }
  // A silly count is clamped to kMaxParticles, so the per-pixel cost stays bounded however
  // the .bin was built - and the program still runs.
  {
    auto blob = build(1, 1e9f);
    ProtoShadeRuntime rt(1, 1);
    assert(rt.load(blob.data(), blob.size()));
    ExecContext ctx;
    rt.renderFrame(ctx, rt.beginFrame(0), nullptr);
    assert(!ctx.budget_exceeded);
    Pixel px{};
    rt.renderRows(ctx, rt.beginFrame(0), 0, 1, &px);
    assert(ctx.steps_used <= format::kMaxParticles * 14 && !ctx.budget_exceeded);
  }
}

// Frame-uniform instructions - time, sensors, constants, anything derived from them - are
// hoisted out of the per-pixel loop. A shader driving a sine from time alone was paying for
// that sine on every pixel.
void testUniformHoisting() {
  // Nothing here depends on the pixel: the whole program is uniform and a pixel costs zero.
  {
    ProtoShadeRuntime rt(4, 4);
    auto blob = flatColour(1, 0.5f, 0).blob();
    assert(rt.load(blob.data(), blob.size()));
    assert(rt.instructionCount() == 1);
    assert(rt.uniformInstructions() == 1 && rt.pixelInstructions() == 0);
    // Still renders the right colour: the value the uniform pass left in the register is
    // what every pixel reads.
    ExecContext ctx;
    const Frame f = rt.beginFrame(0);
    std::vector<Pixel> frame(16);
    rt.renderFrame(ctx, f, frame.data());
    for (const Pixel& p : frame) assert(p.r == 255 && near(p.g, 128) && p.b == 0);
  }

  // Time in, coordinates in: the time half hoists, the coordinate half does not.
  {
    Builder p;
    const uint8_t t = p.emit(Op::Time, p.scalar(1));
    const uint8_t wave = p.emit(Op::Math, t, p.scalar(0), 0, 0, 11);   // sine(time)
    const uint8_t uv = p.emit(Op::UV);
    const uint8_t mixed = p.emit(Op::Math, uv, wave, 0, 0, 0);         // uv + sine(time)
    p.emit(Op::Output, mixed, p.scalar(1));

    ProtoShadeRuntime rt(4, 4);
    auto blob = p.blob();
    assert(rt.load(blob.data(), blob.size()));
    assert(rt.instructionCount() == 5);
    // Time and the sine run once per frame; UV, the add and the output run per pixel.
    assert(rt.uniformInstructions() == 2);
    assert(rt.pixelInstructions() == 3);

    // And the answer is unchanged: renderRows (which hoists) must agree with sample()
    // (which does not), pixel for pixel.
    ExecContext row_ctx, one_ctx;
    const Frame f = rt.beginFrame(1500);
    std::vector<Pixel> rows(16);
    rt.renderFrame(row_ctx, f, rows.data());
    for (uint16_t y = 0; y < 4; y++) {
      for (uint16_t x = 0; x < 4; x++) {
        const Pixel direct = rt.sample(one_ctx, f, x, y);
        const Pixel& hoisted = rows[y * 4 + x];
        assert(direct.r == hoisted.r && direct.g == hoisted.g && direct.b == hoisted.b);
      }
    }
  }

  // Writing a register twice would make hoisting unsound, so it is refused at load.
  {
    Builder p;
    p.emit(Op::UV);          // writes r0
    p.emit(Op::UV);          // writes r1...
    p.code[9] = 0;           // ...patched to write r0 as well
    p.emit(Op::Output, 0, p.scalar(1));
    ProtoShadeRuntime rt;
    auto blob = p.blob();
    assert(!rt.load(blob.data(), blob.size()) && rt.status() == Status::BadProgram);
  }
}

void testStepBudget() {
  // A program that actually costs something per pixel: a constant colour is entirely
  // uniform now, so its pixels are free and no budget can be blown by them.
  Builder heavy;
  heavy.emit(Op::Output, heavy.emit(Op::UV), heavy.scalar(1));
  auto blob = heavy.blob();
  ProtoShadeRuntime rt(4, 4);
  assert(rt.load(blob.data(), blob.size()));

  ExecContext ctx;
  ctx.step_limit = 0;  // a budget no program can fit in
  const Pixel p = rt.sample(ctx, rt.beginFrame(0), 0, 0);
  assert(ctx.budget_exceeded && p.r == 0 && p.g == 0 && p.b == 0);

  ExecContext ok;
  assert(!ok.budget_exceeded);
  rt.sample(ok, rt.beginFrame(0), 0, 0);
  // steps_used is what a PIXEL costs, which is the varying half of the program.
  assert(ok.steps_used == rt.pixelInstructions() && !ok.budget_exceeded);
}

// The whole point of the two-core split: halves rendered separately must equal one pass.
void testRowSplitMatchesWholeFrame() {
  Builder p;
  p.emit(Op::Output, p.emit(Op::UV), p.scalar(1));
  auto blob = p.blob();

  ProtoShadeRuntime rt(16, 9);  // odd height, so the split is uneven
  assert(rt.load(blob.data(), blob.size()));
  const Frame f = rt.beginFrame(1234);

  std::vector<Pixel> whole(16 * 9), split(16 * 9);
  ExecContext ctx_all, ctx_top, ctx_bottom;
  rt.renderFrame(ctx_all, f, whole.data());

  const uint16_t mid = 9 / 2;
  rt.renderRows(ctx_top, f, 0, mid, split.data());
  rt.renderRows(ctx_bottom, f, mid, 9, split.data() + size_t(mid) * 16);
  assert(std::memcmp(whole.data(), split.data(), whole.size() * sizeof(Pixel)) == 0);

  // Bad ranges write nothing rather than running off the buffer.
  std::vector<Pixel> guard(16 * 9, Pixel{7, 7, 7});
  rt.renderRows(ctx_all, f, 5, 5, guard.data());
  rt.renderRows(ctx_all, f, 0, 100, guard.data());
  rt.renderRows(ctx_all, f, 0, 9, nullptr);
  assert(guard[0].r == 7);
}

// ---------------------------------------------------------------------------
// Panel mapping: the canvas -> physical display step. Rotation and mirroring are the two
// things that look fine in a comment and come out wrong on a head, so they get a canvas
// with a known value in every pixel and an exact expected layout.
// ---------------------------------------------------------------------------

struct RecordingDisplay : Display {
  std::vector<Pixel> got;
  uint16_t w = 0, h = 0;
  int pushes = 0;
  void push(const Pixel* rgb, uint16_t width, uint16_t height) override {
    got.assign(rgb, rgb + size_t(width) * height);
    w = width;
    h = height;
    pushes++;
  }
};

// Canvas 3x2, every pixel tagged with its own coordinates: red = x, green = y.
std::vector<Pixel> tagCanvas(uint16_t w, uint16_t h) {
  std::vector<Pixel> c(size_t(w) * h);
  for (uint16_t y = 0; y < h; y++) {
    for (uint16_t x = 0; x < w; x++) c[size_t(y) * w + x] = Pixel{uint8_t(x), uint8_t(y), 9};
  }
  return c;
}

bool at(const RecordingDisplay& d, uint16_t x, uint16_t y, uint8_t cx, uint8_t cy) {
  const Pixel& p = d.got[size_t(y) * d.w + x];
  return p.r == cx && p.g == cy;
}

void testPanelMapping() {
  const auto canvas = tagCanvas(3, 2);
  std::vector<Pixel> scratch(64);

  // Straight through: panel pixel (x,y) is canvas pixel (x,y).
  {
    RecordingDisplay d;
    Panel p{&d, 0, 0, 3, 2, Orient::Normal, false, false};
    pushPanel(p, canvas.data(), 3, 2, scratch.data());
    assert(d.pushes == 1 && d.w == 3 && d.h == 2);
    assert(at(d, 0, 0, 0, 0) && at(d, 2, 1, 2, 1));
  }

  // A rectangle out of the middle: the rest of the canvas is simply never displayed.
  {
    RecordingDisplay d;
    Panel p{&d, 1, 0, 2, 2, Orient::Normal, false, false};
    pushPanel(p, canvas.data(), 3, 2, scratch.data());
    assert(d.w == 2 && d.h == 2);
    assert(at(d, 0, 0, 1, 0) && at(d, 1, 1, 2, 1));
  }

  // Mirrored: the same drawing feeding the other side of the face.
  {
    RecordingDisplay d;
    Panel p{&d, 0, 0, 3, 2, Orient::Normal, true, false};
    pushPanel(p, canvas.data(), 3, 2, scratch.data());
    assert(at(d, 0, 0, 2, 0) && at(d, 2, 0, 0, 0));
  }
  {
    RecordingDisplay d;
    Panel p{&d, 0, 0, 3, 2, Orient::Normal, false, true};
    pushPanel(p, canvas.data(), 3, 2, scratch.data());
    assert(at(d, 0, 0, 0, 1) && at(d, 0, 1, 0, 0));
  }

  // Quarter turn clockwise: a 3x2 piece of canvas lands on a 2x3 panel, and the canvas
  // top-left corner ends up in the panel's top-right.
  {
    RecordingDisplay d;
    Panel p{&d, 0, 0, 2, 3, Orient::Rotate90, false, false};
    assert(p.sourceWidth() == 3 && p.sourceHeight() == 2);
    pushPanel(p, canvas.data(), 3, 2, scratch.data());
    assert(d.w == 2 && d.h == 3);
    assert(at(d, 1, 0, 0, 0));  // canvas (0,0) -> panel top-right
    assert(at(d, 0, 0, 0, 1));  // canvas (0,1) -> panel top-left
    assert(at(d, 1, 2, 2, 0));  // canvas (2,0) -> panel bottom-right
  }

  // Three quarter turns is the other way round.
  {
    RecordingDisplay d;
    Panel p{&d, 0, 0, 2, 3, Orient::Rotate270, false, false};
    pushPanel(p, canvas.data(), 3, 2, scratch.data());
    assert(at(d, 0, 2, 0, 0));  // canvas (0,0) -> panel bottom-left
    assert(at(d, 1, 0, 2, 1));
  }

  // Half turn.
  {
    RecordingDisplay d;
    Panel p{&d, 0, 0, 3, 2, Orient::Rotate180, false, false};
    pushPanel(p, canvas.data(), 3, 2, scratch.data());
    assert(at(d, 0, 0, 2, 1) && at(d, 2, 1, 0, 0));
  }

  // Mapped past the edge: the part that has no canvas under it is black, not garbage.
  {
    RecordingDisplay d;
    Panel p{&d, 2, 1, 3, 2, Orient::Normal, false, false};
    pushPanel(p, canvas.data(), 3, 2, scratch.data());
    assert(at(d, 0, 0, 2, 1));
    const Pixel& off = d.got[1];
    assert(off.r == 0 && off.g == 0 && off.b == 0);
  }

  // Two panels reading the same rectangle, one mirrored: one drawing, both sides of a face.
  {
    RecordingDisplay left, right;
    Panel panels[] = {
        Panel{&left, 0, 0, 3, 2, Orient::Normal, false, false},
        Panel{&right, 0, 0, 3, 2, Orient::Normal, true, false},
    };
    pushPanels(panels, 2, canvas.data(), 3, 2, scratch.data());
    assert(left.pushes == 1 && right.pushes == 1);
    assert(at(left, 0, 0, 0, 0) && at(right, 0, 0, 2, 0));
  }

  // Nothing wired up must not crash: no display, no canvas, zero-sized panel.
  {
    RecordingDisplay d;
    Panel none{nullptr, 0, 0, 3, 2, Orient::Normal, false, false};
    pushPanel(none, canvas.data(), 3, 2, scratch.data());
    Panel empty{&d, 0, 0, 0, 0, Orient::Normal, false, false};
    pushPanel(empty, canvas.data(), 3, 2, scratch.data());
    Panel p{&d, 0, 0, 3, 2, Orient::Normal, false, false};
    pushPanel(p, nullptr, 3, 2, scratch.data());
    pushPanels(nullptr, 3, canvas.data(), 3, 2, scratch.data());
    assert(d.pushes == 0);
  }
}

float kFlex = 0.0f;
float readFlex() { return kFlex; }

void testSensorReading() {
  float values[4] = {7, 7, 7, 7};
  kFlex = 0.75f;
  const SensorInput inputs[] = {{2, readFlex}, {0, nullptr}};
  readSensors(inputs, 2, values, 4);
  assert(values[2] == 0.75f);
  // Slots with nothing wired to them read 0, not whatever was in the buffer last frame.
  assert(values[0] == 0.0f && values[1] == 0.0f && values[3] == 0.0f);

  // A slot past the end of the array is a wiring mistake, not a buffer overrun.
  const SensorInput past[] = {{9, readFlex}};
  readSensors(past, 1, values, 4);
  assert(values[0] == 0.0f);
  readSensors(nullptr, 0, values, 4);
  readSensors(inputs, 2, nullptr, 4);
}

}  // namespace

int main() {
  testLoadRejectsGarbage();
  testAssetValidation();
  testCodeValidation();
  testResolution();
  testNoProgramFallsBackToPattern();
  testOutput();
  testCoordinateOps();
  testMathAndSwizzle();
  testCombineMixOverHsv();
  testTimeAndSensors();
  testTexture();
  testAnimation();
  testParticles();
  testUniformHoisting();
  testStepBudget();
  testRowSplitMatchesWholeFrame();
  testPanelMapping();
  testSensorReading();
  std::puts("all asserts passed");
}
