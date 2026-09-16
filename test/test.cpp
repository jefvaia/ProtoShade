#include <cassert>
#include <cstdio>
#include <cstring>
#include <vector>

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

// Smallest valid container: header + code, optionally one asset. Mirrors what the web app
// has to emit, so if this helper and the packer ever disagree, this test is the arbiter.
std::vector<uint8_t> makeBlob(uint32_t code_len = 4, uint16_t assets = 0, uint32_t asset_len = 6) {
  const uint32_t code_off = format::kHeaderSize;
  const uint32_t table_off = code_off + code_len;
  const uint32_t asset_off = table_off + assets * format::kAssetEntrySize;
  const uint32_t total = asset_off + assets * asset_len;

  std::vector<uint8_t> v(total, 0);
  std::memcpy(v.data(), format::kMagic, 4);
  put16(v, 4, format::kVersion);
  put16(v, 6, 0);       // flags
  put16(v, 8, 64);      // width hint
  put16(v, 10, 32);     // height hint
  put32(v, 12, code_off);
  put32(v, 16, code_len);
  put16(v, 20, assets);
  put32(v, 24, table_off);
  put32(v, 28, total);

  for (uint16_t i = 0; i < assets; i++) {
    const size_t e = table_off + i * format::kAssetEntrySize;
    put32(v, e, asset_off + i * asset_len);
    put32(v, e + 4, asset_len);
    put16(v, e + 8, 3);  // width
    put16(v, e + 10, 1); // height
    v[e + 12] = uint8_t(AssetFormat::RGB565);
  }
  return v;
}

void testLoadRejectsGarbage() {
  ProtoShadeRuntime rt;
  assert(rt.status() == Status::NoProgram);
  assert(!rt.hasProgram());

  assert(!rt.load(nullptr, 0));
  assert(rt.status() == Status::TooSmall);

  auto blob = makeBlob();
  assert(!rt.load(blob.data(), format::kHeaderSize - 1));
  assert(rt.status() == Status::TooSmall);

  auto bad_magic = makeBlob();
  bad_magic[1] = 'X';
  assert(!rt.load(bad_magic.data(), bad_magic.size()));
  assert(rt.status() == Status::BadMagic);

  // A bin from a newer web app must be refused, not misread.
  auto bad_ver = makeBlob();
  put16(bad_ver, 4, format::kVersion + 1);
  assert(!rt.load(bad_ver.data(), bad_ver.size()));
  assert(rt.status() == Status::BadVersion);

  // Code span running past the end of the blob.
  auto bad_code = makeBlob();
  put32(bad_code, 16, 0xFFFF);
  assert(!rt.load(bad_code.data(), bad_code.size()));
  assert(rt.status() == Status::BadLayout);

  // Offset large enough to overflow a 32-bit add: must not wrap into "inside the blob".
  auto overflow = makeBlob();
  put32(overflow, 12, 0xFFFFFFF0);
  put32(overflow, 16, 0x20);
  assert(!rt.load(overflow.data(), overflow.size()));
  assert(rt.status() == Status::BadLayout);

  // Truncated file: declared total_length no longer matches what was handed over.
  auto truncated = makeBlob();
  assert(!rt.load(truncated.data(), truncated.size() - 1));
  assert(rt.status() == Status::BadLayout);

  // An asset pointing outside the blob.
  auto bad_asset = makeBlob(4, 1);
  put32(bad_asset, format::kHeaderSize + 4, 0xFFFF);
  assert(!rt.load(bad_asset.data(), bad_asset.size()));
  assert(rt.status() == Status::BadLayout);
}

void testLoadAccepts() {
  ProtoShadeRuntime rt;
  auto blob = makeBlob(8, 2);
  assert(rt.load(blob.data(), blob.size()));
  assert(rt.status() == Status::Ok && rt.hasProgram());
  assert(rt.programWidthHint() == 64 && rt.programHeightHint() == 32);
  assert(rt.assetCount() == 2);

  Asset a{};
  assert(rt.asset(0, a));
  assert(a.width == 3 && a.height == 1 && a.format == AssetFormat::RGB565);
  assert(a.data >= blob.data() && a.data + a.length <= blob.data() + blob.size());
  assert(!rt.asset(2, a));  // out of range

  rt.unload();
  assert(rt.status() == Status::NoProgram && rt.assetCount() == 0);
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

void testSampling() {
  ProtoShadeRuntime rt(8, 8);
  ExecContext ctx;
  const Frame f0 = rt.beginFrame(0);

  // The placeholder wave, same shape the pre-shell runtime had.
  assert(rt.sample(ctx, f0, 0, 0).g == 0);
  assert(rt.sample(ctx, rt.beginFrame(256), 0, 0).g == 128);
  assert(rt.sample(ctx, f0, 8 % 8, 0).g == rt.sample(ctx, f0, 0, 0).g);
  assert(rt.sample(ctx, f0, 1, 0).g == rt.sample(ctx, f0, 0, 1).g);  // diagonal symmetry

  // Out of range is black, never a read past the buffer.
  const Pixel oob = rt.sample(ctx, f0, 99, 99);
  assert(oob.r == 0 && oob.g == 0 && oob.b == 0);

  // beginFrame hands out increasing frame indices. Sequenced into locals on purpose:
  // the evaluation order of the two operands of < is unspecified.
  const uint32_t first = rt.beginFrame(0).index;
  const uint32_t second = rt.beginFrame(0).index;
  assert(second == first + 1);
}

// The whole point of the two-core split: halves rendered separately must equal one pass.
void testRowSplitMatchesWholeFrame() {
  ProtoShadeRuntime rt(16, 9);  // odd height, so the split is uneven
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

}  // namespace

int main() {
  testLoadRejectsGarbage();
  testLoadAccepts();
  testResolution();
  testSampling();
  testRowSplitMatchesWholeFrame();
  std::puts("all asserts passed");
}
