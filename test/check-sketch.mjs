// Syntax-checks the ESP32 sketch on a host compiler.
//
//   node test/check-sketch.mjs      (or: npm test)
//
// The sketch is the one part of this repository that only ever gets compiled by the Arduino
// IDE, on someone else's machine, which means a typo or a name collision in it is found by
// the person trying to flash their head. test/arduino-stubs/ has just enough of Arduino.h,
// WiFi, WebServer, LittleFS, esp_partition and FreeRTOS to PARSE it - nothing runs, and
// nothing here can catch a real API mismatch with the ESP32 core. What it does catch is our
// own code: collisions, typos, wrong signatures, missing declarations.
//
// It also compiles src/ProtoShadeParallel.cpp, which is #if-guarded to ESP32 and therefore
// invisible to every other check in this repository.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cxx = process.env.CXX || "g++";
if (spawnSync(cxx, ["--version"]).status !== 0) {
  console.log(`check-sketch: skipped, no ${cxx} on this machine (set CXX to a C++ compiler to run it)`);
  process.exit(0);
}

const units = [
  join(root, "test/sketch-check.cpp"),
  join(root, "upload_mode.cpp"),
  join(root, "src/ProtoShadeParallel.cpp"),
];

let failed = false;
for (const unit of units) {
  const result = spawnSync(
    cxx,
    [
      "-fsyntax-only",
      "-std=gnu++11", // the older ESP32 core's standard: the stricter of the two
      "-Wall",
      "-Wextra",
      "-Wno-unused-parameter", // the stubs ignore theirs on purpose
      "-DARDUINO_ARCH_ESP32=1",
      `-I${join(root, "test/arduino-stubs")}`,
      unit,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    failed = true;
    console.error(result.stderr);
  }
}

if (failed) process.exit(1);
console.log(`check-sketch: ok - ${units.length} translation units parse`);
