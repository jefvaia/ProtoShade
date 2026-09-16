// ProtoShade-Runtime on an ESP32-S3: load a .bin from flash, render it across both cores.
//
// The .bin (code + assets, see the format comment in ProtoShadeRuntime.h) lives in its own
// flash partition, NOT in RTC memory - RTC RAM is 8 KB and loses its contents on power loss.
// esp_partition_mmap() maps the partition into the address space, so the blob costs no RAM
// no matter how many PNGs got packed into it.

#include <esp_partition.h>

#include <ProtoShadeParallel.h>
#include <ProtoShadeRuntime.h>

using namespace protoshade;

constexpr uint16_t WIDTH = 64;
constexpr uint16_t HEIGHT = 32;

ProtoShadeRuntime runtime;
ParallelRenderer renderer;
Pixel framebuffer[WIDTH * HEIGHT];

esp_partition_mmap_handle_t mapping;

// Maps the data partition holding the .bin. Returns false when there is nothing valid there
// yet - the runtime then draws its built-in test pattern instead of nothing at all.
bool loadProgramFromFlash() {
  const esp_partition_t* part =
      esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "protoshade");
  if (!part) {
    Serial.println("no 'protoshade' partition in the partition table");
    return false;
  }

  const void* data = nullptr;
  if (esp_partition_mmap(part, 0, part->size, ESP_PARTITION_MMAP_DATA, &data, &mapping) != ESP_OK) {
    Serial.println("mmap failed");
    return false;
  }

  // The header's total_length says how long the blob really is; the partition is bigger.
  const uint8_t* bytes = static_cast<const uint8_t*>(data);
  uint32_t declared = 0;
  for (int i = 0; i < 4; i++) declared |= uint32_t(bytes[28 + i]) << (8 * i);
  if (declared == 0 || declared > part->size) {
    Serial.println("no program flashed yet");
    return false;
  }

  if (!runtime.load(bytes, declared)) {
    Serial.printf("bad program, status %d\n", int(runtime.status()));
    return false;
  }
  Serial.printf("loaded: %u assets, authored for %ux%u\n", runtime.assetCount(),
                runtime.programWidthHint(), runtime.programHeightHint());
  return true;
}

void setup() {
  Serial.begin(115200);

  runtime.setResolution(WIDTH, HEIGHT);
  loadProgramFromFlash();

  // Two pinned tasks, created once. Core 0 takes the top half, core 1 the bottom.
  if (!renderer.begin()) {
    Serial.println("renderer.begin() failed - out of memory?");
  }
}

void loop() {
  const Frame f = runtime.beginFrame(millis());
  if (!renderer.render(runtime, f, framebuffer)) {
    Serial.println("step budget exceeded - shader is too heavy or looping");
  }

  // Your panel driver goes here: push `framebuffer` (WIDTH * HEIGHT RGB pixels) out over
  // HUB75 / WS2812 / whatever the visor uses.
  const Pixel& p = framebuffer[0];
  rgbLedWrite(RGB_BUILTIN, p.r / 8, p.g / 8, p.b / 8);  // /8 because it is blinding

  delay(16);  // ~60 fps
}
