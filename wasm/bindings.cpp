// Only compiled by em++ (build.bat). Arduino never sees this folder.
#include <emscripten/bind.h>
#include "../src/ProtoShadeRuntime.h"

EMSCRIPTEN_BINDINGS(protoshade_runtime) {
  emscripten::class_<ProtoShadeRuntime>("ProtoShadeRuntime")
    .constructor<uint16_t, uint16_t>()
    .function("pixel", &ProtoShadeRuntime::pixel)
    .function("width", &ProtoShadeRuntime::width)
    .function("height", &ProtoShadeRuntime::height);
}
