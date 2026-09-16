// Renders a .bin to raw RGB on stdout. Used by test/crosscheck.mjs to hold the C++ VM
// against the TypeScript interpreter, and handy on its own when a shader looks wrong:
//
//   g++ -std=c++17 test/render.cpp src/ProtoShadeRuntime.cpp -o /tmp/psrender
//   /tmp/psrender shader.bin 64 32 1500 [sensor0 sensor1 ...] > frame.rgb

#include <cstdio>
#include <cstdlib>
#include <vector>

#include "../src/ProtoShadeRuntime.h"

using namespace protoshade;

int main(int argc, char** argv) {
  if (argc < 5) {
    std::fprintf(stderr, "usage: render <bin> <w> <h> <ms> [sensor values...]\n");
    return 2;
  }

  std::FILE* f = std::fopen(argv[1], "rb");
  if (!f) {
    std::fprintf(stderr, "cannot open %s\n", argv[1]);
    return 2;
  }
  std::fseek(f, 0, SEEK_END);
  const long length = std::ftell(f);
  std::fseek(f, 0, SEEK_SET);
  std::vector<uint8_t> blob(size_t(length < 0 ? 0 : length));
  if (!blob.empty() && std::fread(blob.data(), 1, blob.size(), f) != blob.size()) {
    std::fprintf(stderr, "short read\n");
    return 2;
  }
  std::fclose(f);

  const uint16_t w = uint16_t(std::atoi(argv[2]));
  const uint16_t h = uint16_t(std::atoi(argv[3]));
  const uint32_t ms = uint32_t(std::atol(argv[4]));

  std::vector<float> readings;
  for (int i = 5; i < argc; i++) readings.push_back(float(std::atof(argv[i])));

  ProtoShadeRuntime rt;
  if (!rt.load(blob.data(), blob.size())) {
    std::fprintf(stderr, "load failed, status %d\n", int(rt.status()));
    return 1;
  }
  if (!rt.setResolution(w, h)) {
    std::fprintf(stderr, "bad resolution\n");
    return 1;
  }

  Sensors sensors{readings.empty() ? nullptr : readings.data(), uint8_t(readings.size())};
  ExecContext ctx;
  std::vector<Pixel> frame(size_t(w) * h);
  rt.renderFrame(ctx, rt.beginFrame(ms, sensors), frame.data());
  if (ctx.budget_exceeded) std::fprintf(stderr, "warning: step budget exceeded\n");

  std::fwrite(frame.data(), sizeof(Pixel), frame.size(), stdout);
  return 0;
}
