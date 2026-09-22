#pragma once
// Syntax-check stub, see Arduino.h.
#include <Arduino.h>

enum WiFiMode { WIFI_OFF, WIFI_STA, WIFI_AP };
#define WL_CONNECTED 3

class IPAddress {
public:
  String toString() const { return String(); }
};

class WiFiStub {
public:
  void mode(WiFiMode) {}
  void softAP(const char*, const char*) {}
  bool softAPdisconnect(bool = false) { return true; }
  IPAddress softAPIP() { return IPAddress(); }
  int status() { return 0; }
};
extern WiFiStub WiFi;
