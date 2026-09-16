// Upload mode: WiFi, the editor, and writing a .bin into the flash partition.
//
// Split out of the .ino because none of it is head-specific - you configure a head in
// head_config.h and never touch this file.

#pragma once

#include "src/ProtoShadeRuntime.h"

namespace upload {

// Finds the flash partition and hands the runtime whatever program is already in it.
// Returns false when there is nothing valid there yet; the runtime then draws its built-in
// test pattern, which is what a freshly flashed head shows.
bool loadProgramFromFlash(protoshade::ProtoShadeRuntime& runtime);

// Brings up WiFi (access point, or a network if you set ssid) and the web server. The
// runtime is unloaded while a write is in flight, so nothing renders out of bytes that are
// being erased - which is why program mode must stop rendering before calling this.
bool begin(protoshade::ProtoShadeRuntime& runtime, const char* ap_ssid, const char* ap_password);

// Call from loop() while in upload mode.
void handle();

// Where to point a browser, once begin() has run.
const char* address();

// True when the last upload attempt was rejected. The sketch turns the status LED red on
// it, so a refused .bin is visible from across the room and not only in a browser tab.
bool lastUploadFailed();

}  // namespace upload
