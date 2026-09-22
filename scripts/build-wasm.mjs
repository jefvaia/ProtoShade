// Builds the wasm module with emscripten, on whatever OS you are on.
//
//   npm run build:wasm
//
// Two steps: run the runtime's own tests through em++ (same source the ESP32 compiles, so a
// pass here is a pass there for everything except the Arduino sketch), then emit
// dist/protoshade.js + .wasm for the page to load.
//
// This used to be build.bat, which meant the C++ half of the project only built on Windows.
// Node is already a dependency of the web build, so it is the one interpreter guaranteed to
// be present on every machine that can work on this repository.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "dist");
const src = (...p) => join(root, ...p);

// em++ is a shell script on Linux/macOS and a .bat on Windows; spawning through a shell is
// what makes both resolve off PATH.
const emxx = process.env.EMXX || "em++";

// --if-available: build the module when emscripten is here, say why not and succeed when it
// is not. That is what lets `npm run build` ship the wasm without making emscripten a
// requirement for the editor, the tests or the sketch - none of which need it.
if (process.argv.includes("--if-available") &&
    spawnSync(emxx, ["--version"], { shell: true, stdio: "ignore" }).status !== 0) {
  console.log("wasm: skipped, no emscripten on PATH (source emsdk_env.sh and build again to ship it)");
  process.exit(0);
}
function run(args, label) {
  const result = spawnSync(emxx, args, { stdio: "inherit", shell: true });
  if (result.error || result.status !== 0) {
    console.error(
      `\n${label} failed. Is emscripten on your PATH?\n` +
        `  Linux/macOS: source /path/to/emsdk/emsdk_env.sh\n` +
        `  Windows:     emsdk_env.bat\n` +
        `Everything except the wasm module builds without it: npm run build.`,
    );
    process.exit(1);
  }
}

mkdirSync(out, { recursive: true });

console.log("[1/2] runtime tests");
// Emscripten's node glue is CommonJS and package.json says "type": "module", so node refuses
// a .js file that calls require(). Rename it rather than fight either side - the .wasm beside
// it is still found by name, and emcc will not accept .cjs as an output suffix itself.
const testJs = join(out, "test.js");
const testCjs = join(out, "test.cjs");
rmSync(testCjs, { force: true });
run(
  ["-std=c++17", "-Wall", src("test", "test.cpp"), src("src", "ProtoShadeRuntime.cpp"),
   src("src", "ProtoShadeDisplay.cpp"), "-o", testJs],
  "compiling the runtime tests",
);
renameSync(testJs, testCjs);

const test = spawnSync(process.execPath, [testCjs], { stdio: "inherit" });
if (test.status !== 0) {
  console.error("\nruntime tests failed - not building the wasm module on top of that.");
  process.exit(1);
}

console.log("\n[2/2] wasm library");
run(
  ["-std=c++17", "-O2", src("src", "ProtoShadeRuntime.cpp"), src("wasm", "bindings.cpp"),
   "-lembind", "-sMODULARIZE", "-sEXPORT_ES6", "-o", join(out, "protoshade.js")],
  "compiling the wasm module",
);

console.log(`done: ${existsSync(join(out, "protoshade.wasm")) ? "dist/protoshade.js + dist/protoshade.wasm" : "dist/protoshade.js"}`);
