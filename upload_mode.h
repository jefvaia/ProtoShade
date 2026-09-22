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

// Takes a .bin over the USB serial port the head already logs on, in place of joining its
// access point - which is the only way in on a computer with no WiFi. Blocks until the
// transfer finishes or times out, and reloads the runtime either way. Rendering must be
// stopped before calling it: writing flash takes the cache down with it, and the VM reads
// the program straight out of the mapped partition.
//
// The protocol is at the definition. Returns true when the head is running the new program.
bool receiveOverSerial(protoshade::ProtoShadeRuntime& runtime);

// Brings up WiFi (access point, or a network if you set ssid) and the web server. The
// runtime is unloaded while a write is in flight, so nothing renders out of bytes that are
// being erased - which is why program mode must stop rendering before calling this.
bool begin(protoshade::ProtoShadeRuntime& runtime, const char* ap_ssid, const char* ap_password);

// Call from loop() while in upload mode.
void handle();

// Takes the web server and the access point back down. The mapped partition is left alone -
// the runtime is still reading its program out of it - so the caller can restart the
// renderer straight afterwards and have the face back.
void end();

// millis() when the server last answered anything. Set by begin(), so "nothing has happened
// since upload mode started" and "nothing has happened since the last page" read the same.
uint32_t lastRequestAt();

// millis() when a .bin last landed AND loaded, over WiFi or over USB. 0 when none has this
// time round - which is never a real timestamp, since a head cannot be in upload mode at
// millis() == 0.
uint32_t lastUploadAt();

// Where to point a browser, once begin() has run.
const char* address();

// True when the last upload attempt was rejected. The sketch turns the status LED red on
// it, so a refused .bin is visible from across the room and not only in a browser tab.
bool lastUploadFailed();

}  // namespace upload
