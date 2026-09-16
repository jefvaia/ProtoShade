# ProtoShade

A node-graph shader editor for a protogen head, and the runtime that plays what it makes.

You wire a graph in the browser, the editor compiles it to a `.bin`, you upload that to the
head's own web page, and the ESP32-S3 renders it out of flash across both cores. The
preview in the editor and the panel on your face run **the same compiled program** - not two
implementations of the same idea - and a test renders both and compares pixels.

```
web/nodes.ts  ── graph ──►  web/graph.ts  ── Program ──►  web/pack.ts  ──►  .bin
                                 │                                            │
                                 ▼                                            ▼
                        TypeScript interpreter                    ProtoShadeRuntime (C++)
                           (editor preview)                      (ESP32-S3, and wasm)
```

## Runtime

`src/ProtoShadeRuntime.{h,cpp}` is the portable core (no Arduino.h, no emscripten). It takes
a `.bin`, renders at a chosen resolution, and samples pixels.

```cpp
protoshade::ProtoShadeRuntime rt;
rt.load(blob, len);              // validates the whole container, does NOT copy the assets
rt.setResolution(64, 32);

protoshade::ExecContext ctx;     // one per thread, never shared
const protoshade::Sensors s{readings, count};
const auto frame = rt.beginFrame(millis(), s);
rt.renderRows(ctx, frame, 0, 16, buffer);   // rows [0,16) -> one core's unit of work
```

Threading lives outside the core: wasm has no FreeRTOS, so the core cannot spawn tasks. It
exposes `renderRows()` and the platform splits the frame. `sample()` is `const` and keeps no
shared mutable state, so two cores can run it at once - per-frame values arrive as an
immutable `Frame`, per-thread scratch as a caller-owned `ExecContext`.

`src/ProtoShadeParallel.{h,cpp}` is the ESP32 half of that: two tasks pinned to core 0 and
core 1 each rendering half the frame, plus `PanelPusher`, which sends finished frames to the
panels from a third task. It is the only non-portable file, `#if`-guarded.

`src/ProtoShadeDisplay.{h,cpp}` maps the rendered canvas onto the panels actually screwed
into a head - rotation, mirroring, which rectangle goes where - and is portable and tested.

### The shader VM

A program is **straight-line code**: no jumps, no loops, one 8-byte instruction per used node
output, ordered so every operand is written before it is read. Thirteen opcodes (`UV`,
`MATH`, `MIX`, `OVER`, `HSV`, `TEX`, `SENSOR`, ...), one value type - an RGBA quad of floats.

That shape is the point. The cost of a pixel is known before the first one is drawn, so the
step budget is one comparison instead of accounting inside a loop, and a `.bin` from a web
page cannot spin a head into a watchdog reset. `load()` proves the rest: every offset, every
opcode, every operand index, that no instruction reads a register nothing has written, and
that every texel of every image is inside the blob. After that the interpreter has no guards
in it at all.

### Sensors

`Frame::sensors` is a borrowed `float*` plus a count, indexed by slot - slot 3 is what the
editor's Sensor node with index 3 reads.

They live in `Frame`, snapshotted once per frame, rather than being read inside `sample()`,
because two cores render one frame at the same time: a reading that changed halfway through
would put a different value in the top half of the face than the bottom, and you would see
the seam. Names and ranges never reach the device - the web app resolves both at pack time,
and the squash from an unbounded reading into 0..1 is compiled into the code. A head with
fewer sensors than a program expects still runs it: a missing slot reads the value the
author left in the node.

### ESP32-S3 notes

- **Both cores**, via `ParallelRenderer`. With the web server running, core 0 also serves
  WiFi, so the top half is the slower one.
- **Single-precision floats only** - the S3's FPU has no double. The runtime compiles clean
  under `-Wdouble-promotion`; keep it that way, a stray `1.0` literal costs a soft-float call
  per pixel.
- **The program is copied into RAM at `load()`** (code, constants, asset headers - under
  3 KB). The blob itself is mapped flash and every read goes through a 32 KB cache the
  framebuffer and images are already competing for.
- **The images are not copied.** `esp_partition_mmap()` is why `load()` borrows: a megabyte
  of packed PNGs costs no RAM.
- **Per-pixel divides are gone** - `setResolution()` precomputes the reciprocals, and
  `beginFrame()` converts ms to seconds once per frame.
- Build with `-O2`; the Arduino default is `-Os`. Worth measuring `-O3` on the VM loop.
- Keep the framebuffer in internal SRAM, not PSRAM.

### The .bin container

One file holds everything: the compiled program plus the images (PNGs converted at pack time
to RGB565, or RGBA8888 when they actually use alpha - the ESP32 never decodes PNG). Layout is
documented at the top of `ProtoShadeRuntime.h`; `test/test.cpp` builds one byte by byte and is
the arbiter if the packer and the runtime ever disagree.

It belongs in a **flash** partition, not RTC memory - RTC RAM is 8 KB and is lost on power
loss. Everything a program declares is bounds-checked at `load()`, and `ExecContext::step_limit`
caps work per pixel. Both matter because the `.bin` arrives from a web page: untrusted input,
running on hardware strapped to someone's head.

## Build

Three independent builds, all writing into `dist/`:

```
build.bat              # em++: runs test/test.cpp, then emits dist/protoshade.js + .wasm
npm install
npm run build          # typecheck + tests + minified dist/index.html, main.js, styles.css
npm run build:device   # the above, plus examples/ProtoShadeHead/data/ for the head
```

Serve `dist/` over HTTP (not `file://` - it is an ES module) and open `index.html`.
`npm run dev` watches `web/`, rebuilds and serves on http://localhost:8000.

## Website

Plain HTML + Tailwind v4 + TypeScript, no framework:

- `web/index.html` — markup, Tailwind utility classes
- `web/main.ts` — page wiring: editor, resolution, preview loop, download
- `web/nodes.ts` — the node library and the instruction set they compile to
- `web/graph.ts` — graph → Program, and the interpreter that runs one
- `web/pack.ts` — Program → `.bin`
- `web/vendor/` — third-party files, committed (no CDN: the ESP32 has no internet)

### The shader editor

A Blender-style node graph (litegraph) on the left, an LED-matrix preview on the right. Set
the panel resolution in the header - free text, clamped to 1..512 per side, the container's
`kMaxDimension`. Right-click the canvas to add a node.

Every value is **RGBA**: a plain number broadcasts to `[n, n, n, 1]` (opaque), and a node
that wants a single number reads R. Alpha survives from an uploaded PNG through `Alpha Over`
to `LED Output`, which flattens it against black - the panel has nothing behind it.

Nodes: `Coordinates` (UV / centered / pixel), `Time`, `Sensor`, `Value`, `Color`, `Math` (21
component-wise ops), `Mix`, `Alpha Over`, `Separate`/`Combine RGBA`, `HSV`, `Image` and
`LED Output`. An unconnected input falls back to the node's own widget.

The `Image` node's **wrap** decides what happens outside the image, which matters the moment
you scale the UV to place a sprite:

- `clip` (default) — nothing outside 0..1. The sprite appears once and stops.
- `clamp` — the edge texel stretches outwards. Scale the UV by 2.3 and the last column and
  row of the image smear across the rest of the panel, which is where those streaks come
  from. Useful for a deliberate gradient off the edge, wrong for a sprite.
- `repeat` — tiles.

With `linear` filtering, `clip` fades the alpha at the boundary but keeps the edge colour,
so a sprite feathers out instead of picking up a dark fringe.

The graph autosaves to `localStorage` (uploads included) and reloads with the page.

## The head

`examples/ProtoShadeHead` is the whole thing: boot, face, upload mode, panel mapping.

### Compiling it in the Arduino IDE

`#include <ProtoShadeParallel.h>` searches Arduino's **libraries** folder, not the folder
the sketch happens to sit in. Cloning the repo into your sketchbook is not enough - the IDE
has to see this repository *as a library*, which it already is (`library.properties` plus
`src/` at the root). Pick one:

**Junction (best while developing)** - the repo stays where it is, git and all, and the IDE
follows a link to it. In a Windows terminal, with the repo at `Documents\Arduino\protoshade`:

```
mklink /J "%USERPROFILE%\Documents\Arduino\libraries\ProtoShade" "%USERPROFILE%\Documents\Arduino\protoshade"
```

macOS/Linux: `ln -s ~/Documents/Arduino/protoshade ~/Documents/Arduino/libraries/ProtoShade`

**Or move it**: put the repo at `Documents/Arduino/libraries/ProtoShade` outright.

**Or zip it**: Sketch ▸ Include Library ▸ Add .ZIP Library, pointing at a zip of the repo
root. Fine for using it, annoying for editing it - you reinstall on every change.

Restart the IDE. The examples then show up under File ▸ Examples ▸ ProtoShade-Runtime, and
that is the copy to open - opening the `.ino` by path works too, once the library is visible.

Then in **Tools**:

| Setting | Value |
| --- | --- |
| Board | ESP32S3 Dev Module |
| Flash Size | **8MB** - `partitions.csv` is laid out for 8 MB and the upload fails if the table does not fit |
| Partition Scheme | **Custom** - it uses the `partitions.csv` sitting next to the `.ino` |
| PSRAM | whatever your board has; the framebuffers are small and stay in internal SRAM |

If your board is 4 or 16 MB, edit the offsets in `partitions.csv` to match - the comment at
the top of that file says which two partitions matter and why.

Serving the editor off the head also needs `examples/ProtoShadeHead/data/` (from
`npm run build:device`) uploaded to LittleFS, which IDE 2.x needs the
`arduino-littlefs-upload` extension for. Skip it entirely and `/upload` still works - that
page is built into the sketch.

### Boot

The face starts rendering **immediately**. For the first 60 seconds the button is armed -
press it and the head switches to upload mode instead. After the window it is ignored, so a
knock mid-con cannot drop your face into an access point.

Deliberately not a 60-second wait before anything lights up: a dark visor for a minute on
every power-up is the wrong trade. If you want the hard wait, move the check into `setup()`.

### Program mode (the face)

Three tasks. `ParallelRenderer` renders the top half of the frame on core 0 and the bottom
on core 1; `PanelPusher` sends the finished frame to the panels from its own task, so the
next frame renders while the last one is still going out. Two canvases alternate between
them and that is the entire synchronisation - no lock in the render path:

```cpp
pusher.submit(a);   // returns as soon as the push task takes it
render into b;      // overlaps the push of a
pusher.submit(b);   // waits out a's push, then hands over b
render into a;      // a is free: submit(b) did not return until its push finished
```

### Upload mode

WiFi comes up as an access point (`ProtoShade`), the panels show a slow blue pulse so you
can see what mode the head is in from across the room, and the VM stops - upload mode erases
the bytes it would be reading. Open **http://192.168.4.1/upload**, pick the `.bin`.

The sketch validates the header *before* erasing anything, so a garbage upload cannot wipe a
program that works, then streams it into flash a sector at a time and loads it. It survives
power loss because it is in flash, not RAM.

`npm run build:device` also puts the whole editor (gzipped, 133 KB) into
`examples/ProtoShadeHead/data/` for the LittleFS partition, so the head serves the editor
itself at `http://192.168.4.1/` with no computer involved. Skip it and `/upload` still works.

### Wiring a head: `head_config.h`

One file per head, and `ProtoShadeHead.ino` never changes. It holds five things:

1. **The canvas** - the whole face as one drawing, at the resolution you author at.
2. **The button** - pin, polarity, how long the window stays open.
3. **The display drivers** - one `Display` subclass per panel type. A `SerialDisplay` that
   needs no hardware is included; HUB75-over-DMA and WS2812 sketches are in the comments.
   The library depends on no driver library, and neither does the sketch until you pick one.
4. **The map** - which rectangle of the canvas each panel shows, and how it is mounted
   (`Orient` quarter turns, `mirror_x`, `mirror_y`). Two panels may read the *same*
   rectangle: that is how one drawing feeds both sides of a face, mirrored. Canvas no panel
   reads is simply never displayed - nothing has to be masked off - and a panel mapped past
   the edge shows black there rather than whatever is next to the framebuffer.
5. **The sensors** - slot number plus a function returning that sensor's value in the range
   its Sensor node declares. A slot nothing is wired to reads 0; a slot the program wants
   but this head lacks falls back to the value baked into the `.bin`, so a half-wired head
   still renders.

## Tests

```
npm test                                     # both JS checks
g++ -std=c++17 test/test.cpp src/ProtoShadeRuntime.cpp -o /tmp/t && /tmp/t
```

- `test/graph.test.mjs` — the compiler: what a graph turns into, dead branches dropped,
  cycles cut, pooled constants, alpha, sensors, and the container header.
- `test/crosscheck.mjs` — **the important one.** Compiles 55 programs, renders every pixel
  with the TypeScript interpreter, packs the same Program to a `.bin`, renders that with the
  C++ VM, and compares. Currently 99.4% of channels are bit-identical and nothing differs by
  more than 1/255, which is float-vs-double rounding of the last bit. A drifting opcode shows
  up here as a wrong pixel. Needs a host C++ compiler; skips without one.
- `test/test.cpp` — the runtime: container validation against malformed input, every opcode,
  the step budget, that two half-frames equal one whole one, and the panel mapping - every
  rotation and mirror against a canvas tagged with its own coordinates, because that is what
  looks fine in a comment and comes out upside down on a head.
- `test/render.cpp` — renders a `.bin` to raw RGB on stdout. Used by the cross-check, handy
  on its own when a shader looks wrong.
