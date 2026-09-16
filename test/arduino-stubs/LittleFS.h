#pragma once
// Syntax-check stub, see Arduino.h.
#include <Arduino.h>

class File {
public:
  explicit operator bool() const { return false; }
  void close() {}
};

class FsStub {
public:
  bool begin(bool = false) { return false; }
  bool exists(const String&) { return false; }
  File open(const String&, const char*) { return File(); }
};
extern FsStub LittleFS;
