// Only compiled by em++ (build.bat). Arduino never sees this folder.
#include <emscripten/bind.h>

#include <cstring>
#include <vector>

#include "../src/ProtoShadeRuntime.h"

using namespace protoshade;

namespace {

// Browser-side face of the runtime. It exists so the page can render a whole frame with one
// call and read the result through a typed array, instead of crossing into wasm per pixel -
// at 64x32 that difference is the whole frame budget.
class WebRuntime {
public:
  // program arrives as a JS Uint8Array (the .bin the packer just built, or one read back
  // from the device). Copied into wasm memory because the runtime does not own its blob and
  // a JS-side buffer can be garbage collected or detached under it.
  bool load(const emscripten::val& program) {
    const unsigned length = program["length"].as<unsigned>();
    blob_.resize(length);
    if (length) {
      emscripten::val view(emscripten::typed_memory_view(blob_.size(), blob_.data()));
      view.call<void>("set", program);
    }
    return rt_.load(blob_.data(), blob_.size());
  }

  void unload() { rt_.unload(); }
  int status() const { return int(rt_.status()); }
  bool hasProgram() const { return rt_.hasProgram(); }

  bool setResolution(uint16_t w, uint16_t h) {
    const bool ok = rt_.setResolution(w, h);
    frame_.assign(size_t(rt_.width()) * rt_.height(), Pixel{0, 0, 0});
    return ok;
  }
  uint16_t width() const { return rt_.width(); }
  uint16_t height() const { return rt_.height(); }
  uint16_t assetCount() const { return rt_.assetCount(); }

  // Renders the whole frame into wasm memory. The browser is single-threaded here, which is
  // exactly why the core does not own the threading: the ESP32 splits this across two cores
  // (ProtoShadeParallel), the browser just calls it straight.
  bool render(uint32_t ms) {
    if (frame_.empty()) setResolution(rt_.width(), rt_.height());
    const Frame f = rt_.beginFrame(ms);
    ctx_.budget_exceeded = false;
    rt_.renderFrame(ctx_, f, frame_.data());
    return !ctx_.budget_exceeded;
  }

  // RGB bytes of the last render, as a view straight onto wasm memory - no copy.
  // Invalidated by setResolution() or by wasm memory growth, so do not cache it.
  emscripten::val pixels() {
    return emscripten::val(emscripten::typed_memory_view(frame_.size() * 3,
                                                         reinterpret_cast<uint8_t*>(frame_.data())));
  }

  // One pixel, for probing/debug. Per-pixel calls from JS are slow - use render() for frames.
  emscripten::val sample(uint16_t x, uint16_t y, uint32_t ms) {
    const Frame f = rt_.beginFrame(ms);
    const Pixel p = rt_.sample(ctx_, f, x, y);
    emscripten::val out = emscripten::val::object();
    out.set("r", p.r);
    out.set("g", p.g);
    out.set("b", p.b);
    return out;
  }

private:
  ProtoShadeRuntime rt_;
  ExecContext ctx_;
  std::vector<uint8_t> blob_;
  std::vector<Pixel> frame_;
};

}  // namespace

EMSCRIPTEN_BINDINGS(protoshade_runtime) {
  static_assert(sizeof(Pixel) == 3, "pixels() hands JS a tightly packed RGB view");

  emscripten::class_<WebRuntime>("ProtoShadeRuntime")
      .constructor<>()
      .function("load", &WebRuntime::load)
      .function("unload", &WebRuntime::unload)
      .function("status", &WebRuntime::status)
      .function("hasProgram", &WebRuntime::hasProgram)
      .function("setResolution", &WebRuntime::setResolution)
      .function("width", &WebRuntime::width)
      .function("height", &WebRuntime::height)
      .function("assetCount", &WebRuntime::assetCount)
      .function("render", &WebRuntime::render)
      .function("pixels", &WebRuntime::pixels)
      .function("sample", &WebRuntime::sample);
}
