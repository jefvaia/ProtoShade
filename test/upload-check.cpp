// Drives a .bin through the head's flash protocol, on the host.
//
//   part of: node test/check-sketch.mjs   (or: npm test)
//
// upload_mode.cpp is the one file that stands between a .bin leaving the browser and the
// bytes the VM renders out of, and until this file existed it was only ever syntax-checked.
// Everything it does is invisible from either end: the editor says it sent the file, the
// head says it stored it, and whether the bytes in flash are the bytes that were sent is a
// question only the panels answer - in a colour, on someone's face.
//
// So: a fake NOR flash with NOR's rules (erased is 0xFF, a write can only clear bits, and
// the alignment the ESP-IDF calls demand), the sketch's own upload code on top of it, and a
// real program driven through the real entry point in chunks the size the port actually
// delivers. Then the two questions worth asking - are the bytes right, and does the runtime
// render the same picture out of flash as it does out of RAM.

#include <Arduino.h>
#include <LittleFS.h>
#include <WiFi.h>
#include <esp_partition.h>

#include <cassert>
#include <cstdio>
#include <cstring>
#include <vector>

#include "../src/ProtoShadeRuntime.h"
#include "../upload_mode.h"

using namespace protoshade;

namespace {

constexpr size_t kSector = 4096;
constexpr uint32_t kPartitionSize = 8 * 1024 * 1024;  // partitions.csv

// The fake flash. Not a buffer with a friendly memcpy: NOR flash erases to 0xFF and a write
// can only turn ones into zeros, so writing over something that was never erased leaves the
// old bits behind rather than the new ones. That is the failure this is shaped to catch.
std::vector<uint8_t> flash;
esp_partition_t the_partition{kPartitionSize};
size_t erased_bytes = 0;
size_t written_bytes = 0;
size_t largest_erase = 0;

void resetFlash(uint8_t fill = 0x00) {
  flash.assign(kPartitionSize, fill);
  erased_bytes = 0;
  written_bytes = 0;
  largest_erase = 0;
}

}  // namespace

// --- the platform, as far as an upload is concerned --------------------------

const esp_partition_t* esp_partition_find_first(esp_partition_type_t, esp_partition_subtype_t,
                                                const char*) {
  return &the_partition;
}

esp_err_t esp_partition_mmap(const esp_partition_t*, size_t offset, size_t size,
                             esp_partition_mmap_memory_t, const void** out,
                             esp_partition_mmap_handle_t* handle) {
  assert(offset + size <= flash.size());
  *out = flash.data() + offset;
  *handle = 1;
  return ESP_OK;
}

void esp_partition_munmap(esp_partition_mmap_handle_t) {}

esp_err_t esp_partition_erase_range(const esp_partition_t*, size_t offset, size_t size) {
  // What the real call demands. Getting this wrong is an ESP_ERR_INVALID_ARG on the head
  // and a "flash erase failed" in the log, so it may as well fail here first.
  assert(offset % kSector == 0 && "erase offset must be sector aligned");
  assert(size % kSector == 0 && "erase size must be a whole number of sectors");
  assert(offset + size <= flash.size());
  std::memset(flash.data() + offset, 0xFF, size);
  erased_bytes += size;
  if (size > largest_erase) largest_erase = size;
  return ESP_OK;
}

esp_err_t esp_partition_write(const esp_partition_t*, size_t offset, const void* src,
                              size_t size) {
  assert(offset % 4 == 0 && size % 4 == 0 && "esp_partition_write wants 4-byte alignment");
  assert(offset + size <= flash.size());
  const uint8_t* bytes = static_cast<const uint8_t*>(src);
  // NOR: a write ANDs. Over an erased sector that is just a copy; over anything else it is
  // the corruption that makes a half-written .bin look like a working one.
  for (size_t i = 0; i < size; i++) flash[offset + i] &= bytes[i];
  written_bytes += size;
  return ESP_OK;
}

SerialStub Serial;
WiFiStub WiFi;
FsStub LittleFS;  // upload_mode serves the editor off it; nothing here asks it for a file

namespace {

void put16(std::vector<uint8_t>& v, size_t at, uint16_t x) {
  v[at] = x & 0xFF;
  v[at + 1] = x >> 8;
}
void put32(std::vector<uint8_t>& v, size_t at, uint32_t x) {
  for (int i = 0; i < 4; i++) v[at + i] = (x >> (8 * i)) & 0xFF;
}
void putf(std::vector<uint8_t>& v, size_t at, float f) {
  uint32_t bits = 0;
  std::memcpy(&bits, &f, 4);
  put32(v, at, bits);
}

/**
 * The shader the editor's "blinking eyes" example produces, byte for byte: UV, Time, Anim,
 * Output, over one RGBA strip of `frames` frames. Deliberately NOT a round number of
 * sectors, and deliberately big enough to need dozens of them - a .bin small enough to fit
 * one sector would never have found anything.
 */
std::vector<uint8_t> animationProgram(uint16_t w, uint16_t h, uint16_t frames) {
  const uint32_t pixels = uint32_t(w) * h * frames;
  const uint32_t asset_len = pixels * 4;

  const uint32_t const_off = format::kHeaderSize;
  const uint32_t consts = 2;  // the Time speed, and the Output brightness
  const uint32_t code_off = const_off + consts * 16;
  const uint32_t code_len = 4 * format::kInstrSize;
  const uint32_t table_off = code_off + code_len;
  const uint32_t data_off = table_off + format::kAssetEntrySize;
  const uint32_t total = data_off + asset_len;

  std::vector<uint8_t> v(total, 0);
  std::memcpy(v.data(), format::kMagic, 4);
  put16(v, 4, format::kVersion);
  put16(v, 8, w);
  put16(v, 10, h);
  put32(v, 12, code_off);
  put32(v, 16, code_len);
  put32(v, 20, const_off);
  put16(v, 24, uint16_t(consts));
  v[26] = 4;  // registers
  v[27] = 0;  // sensor slots
  put16(v, 28, 1);
  put32(v, 32, table_off);
  put32(v, 36, total);

  for (int c = 0; c < 4; c++) putf(v, const_off + c * 4, c == 3 ? 1.0f : 0.4f);        // speed
  for (int c = 0; c < 4; c++) putf(v, const_off + 16 + c * 4, 1.0f);                   // brightness
  const uint8_t code[] = {
      uint8_t(Op::UV),     0, 0,    0, 0, 0, 0, 0,
      uint8_t(Op::Time),   1, 0x80, 0, 0, 0, 0, 0,
      uint8_t(Op::Anim),   2, 0,    1, 0, 0, 0, uint8_t(1 | 32),  // clamp, loop
      uint8_t(Op::Output), 3, 2,    0x81, 0, 0, 0, 0,
  };
  std::memcpy(v.data() + code_off, code, sizeof code);

  put32(v, table_off, data_off);
  put32(v, table_off + 4, asset_len);
  put16(v, table_off + 8, w);
  put16(v, table_off + 10, uint16_t(h * frames));
  v[table_off + 12] = uint8_t(AssetFormat::RGBA8888);
  put16(v, table_off + 13, frames);

  // Every byte different from its neighbours, and never 0xFF: a texel that survived as
  // erased flash has to be distinguishable from a texel that arrived.
  for (uint32_t i = 0; i < pixels; i++) {
    v[data_off + i * 4 + 0] = uint8_t(i * 7);
    v[data_off + i * 4 + 1] = uint8_t(i * 13 + 1);
    v[data_off + i * 4 + 2] = uint8_t(i * 29 + 2);
    v[data_off + i * 4 + 3] = uint8_t((i * 3) | 0x40);
    for (int c = 0; c < 4; c++) {
      if (v[data_off + i * 4 + c] == 0xFF) v[data_off + i * 4 + c] = 0xAB;
    }
  }
  return v;
}

/** The host side of the protocol: 0x02 is already consumed by the sketch, so this is the
    PSUP header and the bytes. */
std::vector<uint8_t> serialTransfer(const std::vector<uint8_t>& bin) {
  std::vector<uint8_t> wire(8);
  std::memcpy(wire.data(), "PSUP", 4);
  put32(wire, 4, uint32_t(bin.size()));
  wire.insert(wire.end(), bin.begin(), bin.end());
  return wire;
}

void queue(const std::vector<uint8_t>& wire) {
  Serial.in = wire.data();
  Serial.in_len = wire.size();
  Serial.in_at = 0;
}

/** Renders a whole frame, so two runtimes can be compared picture to picture. */
std::vector<Pixel> render(ProtoShadeRuntime& rt, uint32_t ms) {
  ExecContext ctx;
  std::vector<Pixel> out(size_t(rt.width()) * rt.height());
  rt.renderFrame(ctx, rt.beginFrame(ms), out.data());
  return out;
}

// A 64x32 face with sixteen frames: 128 KB of asset, which is thirty-two whole sectors and
// a tail that is not one. The tail matters - it is the only part of the file whose sector
// is written without being full.
void testSerialUpload() {
  const std::vector<uint8_t> bin = animationProgram(64, 32, 16);
  assert(bin.size() % kSector != 0 && "the interesting case is a file that ends mid-sector");
  assert(bin.size() > 32 * kSector);

  // Not erased, and not zero either: whatever the last program left behind. A byte that is
  // never written has to be visibly wrong rather than accidentally right.
  resetFlash(0x5A);

  ProtoShadeRuntime rt(64, 32);
  const std::vector<uint8_t> wire = serialTransfer(bin);
  queue(wire);
  assert(upload::receiveOverSerial(rt) && "the transfer was refused");
  assert(Serial.in_at == wire.size() && "the whole file was not read off the port");

  // The bytes in flash are the bytes that were sent.
  for (size_t i = 0; i < bin.size(); i++) {
    if (flash[i] != bin[i]) {
      std::printf("byte %zu of %zu differs: flash 0x%02X, sent 0x%02X (sector %zu, %zu into it)\n",
                  i, bin.size(), flash[i], bin[i], i / kSector, i % kSector);
      assert(false && "the .bin in flash is not the .bin that was sent");
    }
  }
  // Nothing was written past the file except the 0xFF padding of its last sector.
  const size_t padded = ((bin.size() + kSector - 1) / kSector) * kSector;
  for (size_t i = bin.size(); i < padded; i++) assert(flash[i] == 0xFF);
  assert(erased_bytes >= padded && "the region written was not all erased first");
  // No single erase may be long enough to starve the host's ack timeout. Erasing the whole
  // span in one call is what made a multi-megabyte upload die at its first chunk.
  assert(largest_erase <= 64 * 1024 && "one erase call covered more than a block");

  // And the runtime renders the same picture out of flash as it does out of RAM. This is
  // the one that would have caught a torn asset: a wrong texel is a wrong pixel, and
  // erased flash reads 0xFF, which is opaque white.
  assert(rt.hasProgram() && rt.assetCount() == 1);
  ProtoShadeRuntime reference(64, 32);
  assert(reference.load(bin.data(), bin.size()));
  for (const uint32_t ms : {0u, 700u, 1500u, 2600u}) {
    const std::vector<Pixel> from_flash = render(rt, ms);
    const std::vector<Pixel> from_ram = render(reference, ms);
    for (size_t i = 0; i < from_ram.size(); i++) {
      if (from_flash[i].r != from_ram[i].r || from_flash[i].g != from_ram[i].g ||
          from_flash[i].b != from_ram[i].b) {
        std::printf("pixel %zu at %u ms: flash (%u,%u,%u), ram (%u,%u,%u)\n", i, ms,
                    from_flash[i].r, from_flash[i].g, from_flash[i].b, from_ram[i].r,
                    from_ram[i].g, from_ram[i].b);
        assert(false && "the head renders something else than the .bin says");
      }
    }
  }
}

// A transfer that dies halfway must not leave a program that loads.
//
// This is the white face. Half a .bin whose header already says how long the whole thing was
// passes every check the runtime makes - the asset span is inside the declared length, the
// declared length is inside the partition - so it loads, and every texel past the point the
// transfer stopped reads 0xFF, which is opaque white with full alpha. A head that renders a
// blank white visor and keeps doing it after a power cycle is this and nothing else.
void testTruncatedUpload() {
  const std::vector<uint8_t> bin = animationProgram(32, 16, 8);
  resetFlash(0x5A);

  std::vector<uint8_t> wire = serialTransfer(bin);
  wire.resize(wire.size() - 9000);  // the host went away mid-file
  queue(wire);

  ProtoShadeRuntime rt(32, 16);
  assert(!upload::receiveOverSerial(rt) && "a half-sent file was accepted");
  assert(!rt.hasProgram() && "a half-sent file is running on the head");

  // What the panels do about it: the test pattern, which is teal and moves, rather than a
  // white visor. Named here because "white" is the symptom anybody reports.
  const std::vector<Pixel> frame = render(rt, 500);
  bool all_white = true;
  for (const Pixel& p : frame) {
    if (p.r != 255 || p.g != 255 || p.b != 255) all_white = false;
  }
  assert(!all_white && "the head is rendering erased flash - a white face");

  // And it is still refused after a power cycle, which is the case a "fix it on the next
  // upload" repair would miss: the bytes are still in flash, the header is what is not.
  ProtoShadeRuntime rebooted(32, 16);
  assert(!upload::loadProgramFromFlash(rebooted) && "a half-written program survived a reboot");
  assert(!rebooted.hasProgram());
}

// A .bin whose header is wrong never gets as far as erasing anything, so the face that was
// working before the attempt is still there afterwards.
void testBadHeaderKeepsTheOldProgram() {
  const std::vector<uint8_t> good = animationProgram(16, 8, 4);
  resetFlash(0x5A);
  ProtoShadeRuntime rt(16, 8);
  const std::vector<uint8_t> first = serialTransfer(good);
  queue(first);
  assert(upload::receiveOverSerial(rt));
  const std::vector<Pixel> before = render(rt, 400);

  std::vector<uint8_t> bad = good;
  bad[1] = 'X';  // not PSHD any more
  const size_t erased_before = erased_bytes;
  const std::vector<uint8_t> second = serialTransfer(bad);
  queue(second);
  assert(!upload::receiveOverSerial(rt));
  assert(erased_bytes == erased_before && "a rejected upload erased the working program");
  assert(rt.hasProgram() && "the working program did not come back");
  const std::vector<Pixel> after = render(rt, 400);
  for (size_t i = 0; i < before.size(); i++) {
    assert(before[i].r == after[i].r && before[i].g == after[i].g && before[i].b == after[i].b);
  }
}

// A program small enough to be one sector never writes a second one, so nothing but the
// commit erases anything. Get that wrong and the header is written over unerased flash,
// where a NOR write only clears bits and the result is neither the old file nor the new one.
void testSingleSectorUpload() {
  const std::vector<uint8_t> bin = animationProgram(4, 4, 2);
  assert(bin.size() < kSector);
  resetFlash(0x5A);

  ProtoShadeRuntime rt(4, 4);
  const std::vector<uint8_t> wire = serialTransfer(bin);
  queue(wire);
  assert(upload::receiveOverSerial(rt) && "a one-sector program was refused");
  for (size_t i = 0; i < bin.size(); i++) assert(flash[i] == bin[i]);
  assert(rt.hasProgram());
}

}  // namespace

int main() {
  testSerialUpload();
  testSingleSectorUpload();
  testTruncatedUpload();
  testBadHeaderKeepsTheOldProgram();
  std::puts("upload-check: ok");
  return 0;
}
