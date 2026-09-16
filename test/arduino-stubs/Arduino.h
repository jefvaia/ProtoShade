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
  int available() { return 0; }
  int read() { return -1; }
  size_t write(const uint8_t*, size_t) { return 0; }
  size_t write(uint8_t) { return 0; }
};
extern SerialStub Serial;
