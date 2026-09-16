// Only compiled by em++ (build.bat). Arduino never sees this folder.
#include <emscripten/bind.h>
#include "../src/Protoshade.h"

EMSCRIPTEN_BINDINGS(protoshade) {
  emscripten::class_<Protoshade>("Protoshade")
    .constructor<uint16_t, uint16_t>()
    .function("pixel", &Protoshade::pixel)
    .function("width", &Protoshade::width)
    .function("height", &Protoshade::height);
}
