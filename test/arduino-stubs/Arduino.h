#pragma once
// Just enough of the Arduino API for a SYNTAX check of the sketch on a host compiler.
// It is not an emulator and nothing here runs: it exists so that a name collision, a typo
// or a wrong signature in our own code fails here instead of in the IDE. See
// test/check-sketch.mjs.
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>

#define PROGMEM
#define LOW 0
#define HIGH 1
#define INPUT_PULLUP 5
#define INPUT_PULLDOWN 9
#define RGB_BUILTIN 48
#define CHANGE 3
#define IRAM_ATTR
#define digitalPinToInterrupt(pin) (pin)

unsigned long millis();
unsigned long micros();
void delay(unsigned long ms);
void pinMode(uint8_t pin, uint8_t mode);
int digitalRead(uint8_t pin);
void rgbLedWrite(uint8_t pin, uint8_t r, uint8_t g, uint8_t b);
void analogRead(uint8_t pin);
void attachInterrupt(uint8_t pin, void (*handler)(), int mode);
void detachInterrupt(uint8_t pin);

template <typename T, typename U>
constexpr auto min(T a, U b) -> decltype(a < b ? a : b) {
  return a < b ? a : b;
}

class String {
public:
  String() {}
  String(const char*) {}
  String(char) {}
  String(int, unsigned char = 10) {}
  String(unsigned int, unsigned char = 10) {}
  String(long, unsigned char = 10) {}
  String(unsigned long, unsigned char = 10) {}
  String(unsigned char, unsigned char = 10) {}
  String(double, unsigned char = 2) {}
  const char* c_str() const { return ""; }
  bool endsWith(const String&) const { return false; }
  bool startsWith(const String&) const { return false; }
  String& operator+=(const String&) { return *this; }
  bool operator==(const char*) const { return false; }
  bool operator!=(const char*) const { return false; }
};
inline String operator+(const String&, const String&) { return String(); }
inline String operator+(const char*, const String&) { return String(); }

class SerialStub {
public:
  void begin(unsigned long) {}
  int printf(const char*, ...) { return 0; }
  void println(const char* = "") {}
  void println(const String&) {}
  void print(const char*) {}
  void setTimeout(unsigned long) {}
  size_t write(const uint8_t*, size_t) { return 0; }
  size_t write(uint8_t) { return 0; }

  // Bytes a test has queued for the sketch to read. Left empty by everything else, and then
  // the port behaves exactly as it did before this existed: nothing to read, ever. It is
  // here so test/upload-check.cpp can drive the flash protocol through the real code rather
  // than around it - the transfer is the part where a .bin gets corrupted.
  const uint8_t* in = nullptr;
  size_t in_len = 0;
  size_t in_at = 0;

  int available() { return in ? int(in_len - in_at) : 0; }
  int read() { return in && in_at < in_len ? in[in_at++] : -1; }
  size_t readBytes(uint8_t* dst, size_t want) {
    if (!in) return 0;
    const size_t take = want <= in_len - in_at ? want : in_len - in_at;
    memcpy(dst, in + in_at, take);
    in_at += take;
    return take;  // short of `want` is a timeout, which is what a dead transfer looks like
  }
};
extern SerialStub Serial;
