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
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cxx = process.env.CXX || "g++";
if (spawnSync(cxx, ["--version"]).status !== 0) {
  console.log(`check-sketch: skipped, no ${cxx} on this machine (set CXX to a C++ compiler to run it)`);
  process.exit(0);
}

/**
 * What the Arduino builder hands the compiler, not what is on disk.
 *
 * It runs ctags over the .ino and inserts a generated prototype for EVERY function
 * immediately before the FIRST function definition in the file. That hoisting is the one
 * transformation that can turn a sketch every other compiler here accepts into an error on
 * somebody's board: a type a function returns, or takes, has to be declared above that
 * point, because its prototype has been moved up there. "'Request' does not name a type",
 * from a file where Request is plainly declared thirty lines above the function.
 *
 * This is an approximation of ctags, not ctags. It only ever ADDS prototypes, so the worst
 * a missed function costs is that one function going unchecked.
 */
function arduinoPreprocess(source) {
  const lines = source.split("\n");
  // A definition at column zero: a return type, a name, arguments, and an opening brace.
  // Keywords that can also start such a line are the things it must not match.
  const definition =
    /^([A-Za-z_][A-Za-z0-9_:<>,*&\s]*?[\s*&])([A-Za-z_][A-Za-z0-9_]*)\s*\(([^;{]*)\)\s*(const\s*)?\{\s*$/;
  const notAFunction = /^(if|for|while|switch|else|do|struct|class|union|enum|namespace|extern|return|case)\b/;

  const prototypes = [];
  let first = -1;
  lines.forEach((line, i) => {
    const m = definition.exec(line);
    if (!m || notAFunction.test(line)) return;
    if (first < 0) first = i;
    const [, type, name, args] = m;
    // ctags leaves alone anything already declared - and so must this, or a hand-written
    // forward declaration carrying a default argument would collide with the generated one.
    if (new RegExp(`\\b${name}\\s*\\([^;{]*\\)\\s*(const\\s*)?;`).test(source)) return;
    prototypes.push(`${type.trim()} ${name}(${args});`);
  });
  if (first < 0) return source;
  lines.splice(first, 0, ...prototypes);
  return lines.join("\n");
}

const sketch = join(root, "protoshade.ino");
const work = mkdtempSync(join(tmpdir(), "protoshade-sketch-"));
const hoisted = join(work, "sketch.cpp");
writeFileSync(hoisted, arduinoPreprocess(readFileSync(sketch, "utf8")));

const units = [hoisted, join(root, "upload_mode.cpp"), join(root, "src/ProtoShadeParallel.cpp")];

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
      `-I${root}`, // the hoisted sketch is compiled outside the tree it includes from
      unit,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    failed = true;
    console.error(result.stderr);
  }
}

// Two pieces of the sketch are worth running rather than parsing.
//
//   button-check  the latch, which is what stands between a press and upload mode.
//   upload-check  the flash protocol, which is what stands between a .bin and the panels.
//
// Both link the real code against a platform the test file owns, so what runs is the
// sketch's own logic and not a description of it.
for (const [name, sources] of [
  ["button-check", ["test/button-check.cpp", "src/ProtoShadeRuntime.cpp", "src/ProtoShadeDisplay.cpp"]],
  ["upload-check", ["test/upload-check.cpp", "upload_mode.cpp", "src/ProtoShadeRuntime.cpp"]],
]) {
  if (failed) break;
  const binary = join(work, name);
  const build = spawnSync(
    cxx,
    [
      "-std=gnu++11", "-Wall", "-Wextra", "-Wno-unused-parameter",
      "-DARDUINO_ARCH_ESP32=1", `-I${join(root, "test/arduino-stubs")}`,
      ...sources.map((s) => join(root, s)),
      "-o", binary,
    ],
    { encoding: "utf8" },
  );
  if (build.status !== 0) {
    failed = true;
    console.error(build.stderr);
  } else if (spawnSync(binary, { stdio: "inherit" }).status !== 0) {
    failed = true;
  }
}

// The stubs parse, they do not behave, so this one rule has to be read rather than compiled.
// WebServer::streamFile() sends Content-Encoding: gzip itself for a .gz file, and
// sendHeader() appends instead of replacing: a second one makes the browser read
// "gzip, gzip", inflate twice and refuse the page. The editor served off the head is the
// only thing that goes out gzipped, so this is the whole rule.
if (/sendHeader\s*\(\s*"Content-Encoding"/.test(readFileSync(join(root, "upload_mode.cpp"), "utf8"))) {
  failed = true;
  console.error("upload_mode.cpp sends Content-Encoding itself - streamFile() already does, and two of them break the page");
}

if (failed) process.exit(1);
console.log(`check-sketch: ok - ${units.length} translation units parse, the sketch with its prototypes hoisted`);
