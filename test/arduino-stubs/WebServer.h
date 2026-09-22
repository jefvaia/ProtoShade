#pragma once
// Syntax-check stub, see Arduino.h.
#include <Arduino.h>
#include <LittleFS.h>

enum HTTPMethod { HTTP_GET, HTTP_POST };
enum HTTPUploadStatus { UPLOAD_FILE_START, UPLOAD_FILE_WRITE, UPLOAD_FILE_END, UPLOAD_FILE_ABORTED };

struct HTTPUpload {
  HTTPUploadStatus status;
  String filename;
  uint8_t* buf;
  size_t currentSize;
};

class WebServer {
public:
  explicit WebServer(int) {}
  void on(const char*, HTTPMethod, void (*)()) {}
  void on(const char*, HTTPMethod, void (*)(), void (*)()) {}
  void onNotFound(void (*)()) {}
  void begin() {}
  void stop() {}
  void handleClient() {}
  void send(int, const char*, const String&) {}
  void send(int, const char*, const char*) {}
  void send_P(int, const char*, const char*) {}
  void sendHeader(const char*, const char*) {}
  void streamFile(File&, const String&) {}
  HTTPUpload& upload() { return upload_; }
  String uri() { return String(); }

private:
  HTTPUpload upload_{};
};
