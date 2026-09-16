#include <cassert>
#include <cstdio>
#include "../src/ProtoShadeRuntime.h"

int main() {
  ProtoShadeRuntime p(8, 8);
  assert(p.pixel(0, 0, 0) == 0);                  // wave starts dark
  assert(p.pixel(0, 0, 256) == 128);              // phase 64 -> half brightness
  assert(p.pixel(8, 0, 0) == 254);                // phase 128 -> peak
  assert(p.pixel(1, 0, 0) == p.pixel(0, 1, 0));   // diagonal symmetry
  assert(p.width() == 8 && p.height() == 8);
  std::puts("all asserts passed");
}
