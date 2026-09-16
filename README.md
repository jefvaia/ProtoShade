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

A program is **straight-line code**: no jumps, one 8-byte instruction per used node output,
ordered so every operand is written before it is read. Fifteen opcodes (`UV`, `MATH`, `MIX`,
`OVER`, `HSV`, `TEX`, `ANIM`, `PARTICLES`, `SENSOR`, ...), one value type - an RGBA quad of
floats.

That shape is the point. The cost of a pixel is known before the first one is drawn, so the
step budget is one comparison instead of accounting inside a loop, and a `.bin` from a web
page cannot spin a head into a watchdog reset.

`PARTICLES` is the one loop in the whole VM, and it keeps that property rather than breaking
it: its trip count is required to be a **constant operand** and the whole program shares a
budget of `kMaxParticles`, so the work it adds is still a number `load()` can add up. A
particle has no state - its life is a closed form of its index and the clock - which is also
why two cores rendering the same frame can never disagree about where one is.

It is also the one instruction with a **per-frame pass**. Nineteen parameters do not fit in
eight bytes, so the instruction points at a block of consecutive constants; and where each
particle *is*, how big, how turned and how faded depends only on its index and the clock, so
`prepareParticles()` works all of that out once per core per frame, next to the uniform
instructions. Four sines per particle per frame instead of four per particle per *pixel*: on
a 64x32 panel that is 96 of them a frame rather than 98304, on a chip whose `sinf` is
software. What is left in the pixel loop is a subtract, a rotate, a scale and a fetch. The
clock operand is therefore required to be frame-uniform, and `load()` refuses a program that
feeds it a pixel coordinate - the compiler refuses it first, with a sentence rather than a
status code.

The runtime has its own `sinCos()` rather than calling `sinf`, for the same reason: the
browser's `Math.sin` is a double's answer and newlib's is not, and one ulp of difference in a
rotation puts a sprite's edge on the other side of a texel. The same polynomial in the same
order in both languages is agreement by construction, which `test/crosscheck.mjs` holds to.

It also makes one optimisation free. `load()` splits the program in two: an instruction is
**uniform** when nothing it reads varies across the frame - time, sensors, constants, and
everything computed from those - and **per pixel** otherwise, which starts at the three
coordinate opcodes and spreads from there. The uniform half runs once per core per frame,
the per-pixel half runs per pixel. A shader whose animation comes from `sine(time)` was
computing that sine on every one of 4096 pixels and now computes it twice a frame; it is
usually half the program. That is sound only because every register is written exactly once,
which `load()` now proves and refuses programs that break. `load()` proves the rest: every offset, every
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
- **`sinf`, `cosf`, `powf` and friends are software** on this chip, and newlib's argument
  reduction gets slower as the argument grows - a sine of `time * speed` that has been
  running for an hour costs more than one at boot. Uniform hoisting takes most of that
  sting out by calling them once a frame, and it is the reason a shader can get *slower the
  longer it runs* if they ever end up in the per-pixel half.

### The .bin container

One file holds everything: the compiled program plus the images (PNGs converted at pack time
to RGB565, or RGBA8888 when they actually use alpha - the ESP32 never decodes PNG). An image
carries a **frame count**: frames stacked top to bottom, one frame being `height / frames`
rows, so an animation, a sprite sheet and a still are all the same kind of thing and a still
is just the `frames == 1` case. Layout is
documented at the top of `ProtoShadeRuntime.h`; `test/test.cpp` builds one byte by byte and is
the arbiter if the packer and the runtime ever disagree.

It belongs in a **flash** partition, not RTC memory - RTC RAM is 8 KB and is lost on power
loss. Everything a program declares is bounds-checked at `load()`, and `ExecContext::step_limit`
caps work per pixel. Both matter because the `.bin` arrives from a web page: untrusted input,
running on hardware strapped to someone's head.

## Build

Three independent builds, all writing into `dist/`. Linux, macOS and Windows alike - the
only thing that ever needed Windows was `build.bat`, and it is a one-line wrapper now:

```
npm install
npm run build          # typecheck + tests + minified dist/, and the wasm module if em++ is here
npm run build:wasm     # em++: runs the runtime tests, then emits dist/protoshade.js + .wasm
npm run build:device   # build, plus data/ - the editor, for the head's LittleFS
```

`npm run build` ends by building the wasm module too, but only when emscripten is on PATH
(`source emsdk_env.sh`, or `emsdk_env.bat`); without it that step says so and the build still
succeeds. `build:wasm` is the same step without the escape hatch, for when you want to be told
that em++ is missing rather than have it shrug. Everything else - the editor, every test, the
ESP32 sketch - builds without emscripten at all.

The module is not put on the head: `build:device` ships the editor, and the editor previews by
interpreting the compiled program in TypeScript, so a quarter of a megabyte of wasm on the
LittleFS partition would be a quarter of a megabyte nothing loads. The C++ half is also
checked by the tests below with a plain host compiler, so you do not need emscripten to
change the runtime, only to reload the wasm module the page probes for.

Serve `dist/` over HTTP (not `file://` - it is an ES module) and open `index.html`.
`npm run dev` watches `web/`, rebuilds and serves on http://localhost:8000.

## Website

Plain HTML + Tailwind v4 + TypeScript, no framework:

- `web/index.html` - markup, Tailwind utility classes
- `web/main.ts` - page wiring: editor, resolution, preview loop, download
- `web/nodes.ts` - the node library and the instruction set they compile to
- `web/graph.ts` - graph -> Program, and the interpreter that runs one
- `web/pack.ts` - Program -> `.bin`
- `web/serial.ts` - finds the head's frames in the USB stream (see below)
- `web/visor.ts` - the 3D view of the panels (WebGL, no library)
- `web/vendor/` - third-party files, committed (no CDN: the ESP32 has no internet)

### The shader editor

A Blender-style node graph (litegraph) on the left, an LED-matrix preview on the right. Set
the panel resolution in the header - free text, clamped to 1..512 per side, the container's
`kMaxDimension`. Right-click the canvas to add a node.

Every value is **RGBA**: a plain number broadcasts to `[n, n, n, 1]` (opaque), and a node
that wants a single number reads R. Alpha survives from an uploaded PNG through `Blend` to
`LED Output`, which flattens it against black - the panel has nothing behind it.

**Two things that overlap go through `Blend`.** Foreground over background, straight alpha,
composing properly - that is what it is for, and doing it by hand with `Math` gets the alpha
wrong, because `Math` takes its alpha from A alone. Its **mode** decides what happens *inside
the overlap*: `normal`, `multiply`, `screen`, `add`, `lighten`, `darken`, `difference`. Only
the overlap changes - the part of the foreground hanging off the background keeps its own
colour, so `add` brightens where two sprites cross instead of turning one into a silhouette.
`Mix` is the other one, and a different question: it is a straight lerp between two values on
a factor, with no notion of coverage at all.

Nodes: `Coordinates` (UV / centered / pixel), `Time`, `Sensor`, `Value`, `Color`, `Math` (21
component-wise ops), `Mix`, `Blend`, `Separate`/`Combine RGBA`, `HSV`, `Image`, `Animation`,
`Particles`, `Bake` and `LED Output`. An unconnected input falls back to the node's own
widget.

The **examples** dropdown in the header loads a working graph for each of these: a hue
scroll, blinking eyes, a mouth driven by a sensor as a blend shape, embers, two sprites
blended, and a plasma behind a `Bake` node. Their art is drawn procedurally when the example
loads, so none of it is a file in this repository, and `test/examples.test.mjs` compiles
every one of them and holds it to what a head can actually run.

#### Animation, and blend shapes

`Animation` is an `Image` with more than one frame in it. Upload **several PNGs at once**
(they are sorted by filename and become one frame each), a **GIF / APNG / animated WebP**
(unpacked frame by frame through `ImageDecoder`, so Chrome and Edge only), or **one tall
sprite sheet** and say how many frames it is cut into. Whatever you give it is assembled into
a single strip, and that strip is what gets saved and packed - one image, not n.

The **Phase** input picks the frame, and there are two readings of it:

- **loop on** - Phase counts whole cycles, so `frac(phase) * frames` walks the strip and
  starts over. Wire `Time` in (or leave it unwired and use the node's own speed) and it is an
  animation.
- **loop off** - Phase is `0..1` across the strip and holds at both ends. Wire a `Sensor`, or
  anything else that moves between 0 and 1, and the strip is a **blend shape**: 0 is the
  first drawing, 1 is the last, and everything between picks the nearest one.

Interpolating the phase **picks between frames you drew - it does not invent new ones**. A
phase of 0.5 with four frames is frame 1, not half of frame 1 and half of frame 2. If you do
want the dissolve, turn **crossfade** on; it fetches both neighbours and lerps, and costs
twice as much per pixel.

#### Particles

`Particles` scatters an image across the panel: one instruction, no state, nothing stored
between frames. Every particle's whole life is a function of its index and the clock, so
sixty-four of them cost sixty-four texel fetches and not one byte of flash.

| | |
| --- | --- |
| **emission** | `count`, `life` (seconds), `fade` (how much of its alpha it loses over that life), `seed` |
| **launch** | `direction` and `spread` in degrees, `speed`, `speedSpread` |
| **forces** | `accel` along each particle's own direction, `gravityX` / `gravityY` for the push they all share |
| **size** | `size`, `sizeSpread`, `sizeRate` per second, `sizeAccel` |
| **rotation** | `rotation`, `rotSpread`, `rotRate` deg/s, `rotAccel`, all in degrees |

`direction` is a compass bearing: **0 is up the panel, 90 is to the right**. `spread` is the
full cone, so 0 is a straight line and **360 is all around**. Everything with a `Spread` is
symmetric about its own value, and every rate is per second with its acceleration on top -
position, size and rotation all move the same schoolbook way.

The emitter sits wherever the **position input reads zero**, so offsetting that input is how
you move it: the embers example subtracts 0.9 from the vertical to emit along the bottom
edge. That input also decides the space the particles live in - aspect-corrected by default,
so a round sprite stays round on a 64x32 panel.

Hand it a strip and each particle picks its own frame from it, which is a swarm of different
shapes from one upload. The 64-particle budget belongs to the **program**, not the node: two
emitters share it, and the compiler clamps the second one rather than letting the head refuse
a `.bin` the preview was happy with.

#### Bake: trading flash for instructions

`Bake` renders whatever is wired into it **here, in the browser**, over a driver you choose,
and packs the frames as a strip; the node itself becomes a lookup into that strip. The branch
above it stops costing the head anything at all - a twenty-instruction gradient becomes one
texture fetch.

It is a **partial** bake, not a pre-rendered face:

- the driver is still live. `time` loops the strip over `seconds`; `sensor` indexes it by a
  reading, exactly the way a blend shape does. The head picks the frame every frame.
- everything outside that one branch is untouched. Composite a baked branch with live nodes,
  bake two branches on different drivers, react to a second sensor after the lookup - all of
  that still runs on the device.

What it freezes is the branch's *shape*: anything it depends on that is not the driver (a
second sensor, another clock) is sampled once, at the value it had while baking. The cost is
flash, and it adds up fast - `frames x width x height x 2` bytes - so the editor prints the
`.bin` size and says so when it outgrows the head's 2 MB partition.

Bake is also the way out of a graph that will not fit: the register file is 64 instructions
wide, and a branch that is too big to ship is usually still fine to *render*.

The `Image` node's **wrap** decides what happens outside the image, which matters the moment
you scale the UV to place a sprite:

- `clip` (default) - nothing outside 0..1. The sprite appears once and stops.
- `clamp` - the edge texel stretches outwards. Scale the UV by 2.3 and the last column and
  row of the image smear across the rest of the panel, which is where those streaks come
  from. Useful for a deliberate gradient off the edge, wrong for a sprite.
- `repeat` - tiles.

With `linear` filtering, `clip` fades the alpha at the boundary but keeps the edge colour,
so a sprite feathers out instead of picking up a dark fringe.

The graph autosaves to `localStorage` (uploads included) and reloads with the page.

### The visor view

Under the flat preview is the same frame wrapped onto a head: **the left half of the canvas
is one side of the face, the right half the other**, with the nose gap between them - two
panels either side of a nose piece, the way they sit on a real head. The middle columns of
your graph are the pixels nearest the bridge, so a shader that ignores the gap reads as one
picture cut in half. Drag to turn it, scroll to zoom.

It draws whatever the preview canvas holds, which means it follows the interpreter and a
mirrored head over USB alike without knowing which one it is looking at - connect **mirror
head** and you are turning the real frames around.

Plain WebGL, no library: two mirrored strips swept along one quadratic curve (top view: nose
tip, out, then back along the side, offset off the centre line by the nose gap), and a vertex shader that does yaw, pitch and distance
itself rather than carrying a matrix stack. `test/visor.test.mjs` checks the mesh - that each
half of the canvas lands on its own side, that the two panels clear the centre line by the
nose gap, and that the normals point out of the head. A browser without WebGL just hides the canvas; the
flat preview is still the authoritative one.

## The head

`protoshade.ino` at the root of this repository is the whole thing: boot, face, upload mode,
panel mapping. Its parts are `head_config.h` (the file you edit per head) and
`upload_mode.{h,cpp}`.

### Compiling it in the Arduino IDE

**Open `protoshade.ino` and press Verify. There is nothing to install.**

The repository root *is* the sketch folder, and the Arduino builder compiles a sketch's
`src/` subfolder recursively - which is exactly where the library already lives. That is
also why the sketch includes it as `"src/ProtoShadeRuntime.h"` and not
`<ProtoShadeRuntime.h>`: angle brackets would send the compiler off to look in Arduino's
`libraries/` folder, and then you would have to install something.

(If the IDE complains that the file has to live in a folder of the same name, your clone is
called something other than `protoshade` - rename either one to match. Windows and macOS do
not care about the capitalisation; Linux does.)

Then in **Tools**:

| Setting | Value |
| --- | --- |
| Board | ESP32S3 Dev Module |
| Flash Size | what your board actually has. `partitions.csv` is laid out for **16MB**; its header comment has the 8 MB and 4 MB variants |
| Partition Scheme | **Custom** - it uses the `partitions.csv` sitting next to the `.ino`. None of the built-in schemes has a `protoshade` partition, so with one of those the head boots, says so on serial, and sits on its test pattern |
| Erase All Flash Before Sketch Upload | **Disabled** - enabling it wipes the face program every time you upload the sketch |
| PSRAM | whatever your board has; the framebuffers are small and stay in internal SRAM |

If your board is 4 or 8 MB, edit the offsets in `partitions.csv` to match - the comment at
the top of that file has both variants and says which two partitions matter and why.

### Putting the editor on the head (optional)

You do not need this. Run the editor on a computer (`npm run dev`), download the `.bin`,
join the head's AP and upload it at `/upload`. The only thing this buys you is editing a
face with nothing but a phone.

1. `npm run build:device` - writes `data/`, the gzipped editor, next to the sketch. That is
   exactly where filesystem uploaders look.
2. Install the uploader, which Arduino IDE 2.x does not ship: grab the `.vsix` from
   [arduino-littlefs-upload](https://github.com/earlephilhower/arduino-littlefs-upload/releases),
   drop it in the IDE's plugins folder (create it) and restart: `%USERPROFILE%\.arduinoIDE\plugins\`
   on Windows, `~/.arduinoIDE/plugins/` on Linux and macOS.
3. Close the Serial Monitor - the uploader needs the port - then `Ctrl+Shift+P` >
   **Upload LittleFS to Pico/ESP8266/ESP32**.

It writes to the partition labelled `spiffs`, which is why the table calls it that even
though the contents are LittleFS. Then `http://192.168.4.1/` serves the editor itself.

**Using the runtime in your own sketch** instead of this one: the repository is also a valid
Arduino library (`library.properties` + `src/`), so drop it in `Arduino/libraries/` and
`#include <ProtoShadeRuntime.h>` works the usual way. That is the only case that needs an
install, and it is not needed for the head.

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

**Three ways in.** Press the button within 60 seconds of power-on - `BUTTON_PIN` in
`head_config.h`, GPIO 0 (the BOOT button) by default - holding it for a moment, since a
contact bounce is ignored on purpose.

The pin latches its own presses through an edge interrupt, rather than being sampled once a
frame. A frame ends in `pusher.submit()`, which waits for the previous push, and a push runs
whatever `Display::push()` your head configures - the built-in `SerialDisplay` writes to a
USB port that blocks when nobody is draining it. Sampled, a press that starts and ends
between two slow frames simply never happened, which feels exactly like a broken button and
is not. Latched, the press waits for `loop()` instead of the other way round.
`test/button-check.cpp` runs that logic on the host, that case included. Press it *after* the board has booted: holding BOOT
while resetting puts the chip in its ROM download mode, which is a different thing.

Or **type `u` in the serial monitor**, any time, window or not. No button, no wiring, no
window to miss. Use this one when the button is not behaving.

Or skip upload mode entirely and **flash over USB from the editor** - see below. That one
needs no WiFi at either end.

The serial log says which of those is failing:

```
button: GPIO 0 reads released at boot          <- pin and polarity are right
button: GPIO 0 reads PRESSED at boot  <-- ...  <- wrong pin, or inverted polarity
button: a 12 ms press is too short - hold it a moment
upload window closed - power-cycle for the button, or type u here
switching to upload mode: the face stops, WiFi comes up
upload mode: join ProtoShade, open http://192.168.4.1/
```

Miss the window and the button stops doing anything until the next power cycle. That is the
point: your face cannot fall into an access point because something knocked the button.

WiFi then comes up as an access point (`ProtoShade`, password `protogen`), the panels show a
slow blue pulse so you can see the mode from across the room, and the VM stops - upload mode
erases the bytes it would be reading. Join that network and open
**http://192.168.4.1/upload**, pick the `.bin`.

The sketch validates the header *before* erasing anything, so a garbage upload cannot wipe a
program that works, then streams it into flash a sector at a time and loads it. It survives
power loss because it is in flash, not RAM.

`npm run build:device` also puts the whole editor (gzipped, 133 KB) into `data/` for the
LittleFS partition, so the head serves the editor itself at `http://192.168.4.1/` with no
computer involved. Skip it and `/upload` still works.

### Frame timings

Every two seconds (`STATS_INTERVAL_MS` in `head_config.h`, 0 to silence it) face mode prints:

```
stats: 143.2 fps  render 5.94 ms  panels 0.81 ms
```

Split into the two things that can be the bottleneck, because "it is slow" on its own tells
you nothing:

- **render** - inside `renderer.render()`, both cores. Big here means the shader is too
  heavy for this canvas: fewer instructions, or fewer pixels.
- **panels** - blocked in `pusher.submit()`, waiting for the *previous* frame to finish
  going out. Big here means the display driver is the limit, not the shader, and the push
  task is already doing its job of overlapping the two.

Both are per frame, averaged over the window.

### Mirroring the head in the editor

**mirror head** in the header connects to the board over USB and shows what the *hardware*
is rendering, in place of the local preview. Two implementations can agree on every test and
still differ on a real head - a panel wired the wrong way round, a sensor reading nothing, a
frame rate that only collapses after ten minutes - and this is the view that shows it. No
extra wiring: the cable is already there.

Press it, pick the port, and the editor sends `p` - the same command the serial monitor
takes. The head then writes each frame onto the port it already logs on:

```
"PSFR" | width u16 | height u16 | format u8 | flags u8 | width*height*3 bytes RGB
```

Logs and frames share the stream, so the parser resynchronises on the magic rather than
assuming it starts clean, and a frame older than a second drops the preview back to
rendering locally instead of leaving a stale picture up that looks live.

Throttled to 20 fps by `STREAM_INTERVAL_MS` in `head_config.h` - a 128×32 frame is 12 KB and
the point is to watch the head, not to keep up with it. `Serial.write()` blocking when the
host stops reading is the backpressure that keeps a port nobody is listening to from
stalling the face.

Web Serial is Chrome or Edge on the desktop, over https or localhost; elsewhere the button
is disabled and says why. **Only one program can hold the port** - close the Arduino Serial
Monitor first, and disconnect here before flashing.

### Flashing over USB

**flash over USB** in the header writes the `.bin` straight into the head's flash partition
over the cable that is already there. No access point to join, no browser hop, no WiFi at
either end - which is the only way in on a desktop that has no radio in it. The face pauses,
the partition is written, and the head is running the new program a second or two later.

```
host -> head:  0x02 "PSUP" length_u32_le, then the bytes
head -> host:  "psflash ready <n>", one "psflash ack <n>" per chunk, then
               "psflash done ..." or "psflash error ..."
```

The ack is flow control, not politeness: writing a sector takes tens of milliseconds and the
device's receive buffer is a few hundred bytes, so the head has to say when it is ready for
more. One chunk is in flight at a time, and a transfer that dies halfway stops instead of
quietly storing a truncated program.

The trigger byte is `0x02` rather than a letter because a person typing in a serial monitor
shares this port, and every printable character is either a command already or one someone
could send by accident. Everything after it is read by `upload::receiveOverSerial()`, which
is also where the protocol is written down.

The head checks the header *before* erasing anything, exactly as the web upload does - both
go through the same `feed()` - so a bad file cannot wipe a face that works. Rendering stops
first: erasing flash takes the cache down with it, and the VM reads the program straight out
of the mapped partition. The button interrupt is detached for the same reason.

`test/serial.test.mjs` drives the whole exchange against a fake port: the magic and the
length, one chunk in flight at a time, the tail chunk, and a head that refuses mid-transfer
surfacing as a refusal rather than a stall.

### The status LED

The devkit's built-in RGB LED is the mode light, which is the only thing telling you
anything before panels are wired:

| Colour | Means |
| --- | --- |
| green | rendering your program |
| blue | upload mode, waiting for a `.bin` |
| red | something is wrong, **or nothing is loaded** - serial says which |

Red covers more than failures on purpose: a head running its built-in test pattern because
no program was ever uploaded is not doing what you asked, and green should mean it is. It
also comes on while `setup()` runs, so a board that hangs on the way up says so instead of
sitting dark and looking dead. A heavy frame flickers it red and back; a driver that failed
to start latches it.

**Every change says why on serial**, which is the difference between a light that tells you
something is wrong and one that tells you what:

```
led: RED - starting up
led: RED - no program in flash - upload a .bin, this is the test pattern
led: RED - a fault was latched at boot - look further up this log
led: RED - step budget exceeded - the shader is too heavy
led: blue - waiting for a .bin
led: green - rendering your program
```

A red that never turns green is one of exactly three things, and the line names which.

Pin and brightness are in `head_config.h` - set `STATUS_LED_PIN` to -1 for a board without
one.

### Wiring a head: `head_config.h`

One file per head, and `protoshade.ino` never changes. It holds six things:

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
5. **The status LED** - pin and brightness, or -1 for a board without one.
6. **The sensors** - slot number plus a function returning that sensor's value in the range
   its Sensor node declares. A slot nothing is wired to reads 0; a slot the program wants
   but this head lacks falls back to the value baked into the `.bin`, so a half-wired head
   still renders.

## Tests

```
npm test                                     # the JS checks
g++ -std=c++17 test/test.cpp src/ProtoShadeRuntime.cpp -o /tmp/t && /tmp/t
```

- `test/visor.test.mjs` - the visor mesh: the canvas split, the nose, the normals.
- `test/graph.test.mjs` - the compiler: what a graph turns into, dead branches dropped,
  cycles cut, pooled constants, alpha, sensors, the container header, that a strip's phase
  only ever lands on a frame that exists, and that a baked branch still renders what it
  replaced while the rest of the graph stays live.
- `test/examples.test.mjs` - every example in the header dropdown: that its node types and
  wires are real, that it compiles, and that it fits both the register file and the head's
  2 MB partition. The examples are data, so this is the compiler pointed straight at them.
- `test/crosscheck.mjs` - **the important one.** Compiles 84 programs, renders every pixel
  with the TypeScript interpreter, packs the same Program to a `.bin`, renders that with the
  C++ VM, and compares. Nothing differs by more than 1/255, which is float-vs-double rounding
  of the last bit, and 99.5% of channels are bit-identical. A drifting opcode shows
  up here as a wrong pixel. It is also why the interpreter rounds through `Math.fround` where
  the device would round in single precision: a last-bit difference in a particle's position
  or a texture coordinate is not a rounding difference, it is a different texel. Needs a host C++ compiler; skips without one.
- `test/test.cpp` - the runtime: container validation against malformed input, every opcode,
  the step budget, that two half-frames equal one whole one, and the panel mapping - every
  rotation and mirror against a canvas tagged with its own coordinates, because that is what
  looks fine in a comment and comes out upside down on a head.
- `test/check-sketch.mjs` - parses the ESP32 sketch on a host compiler, against just enough
  of Arduino.h, WiFi, WebServer, LittleFS, esp_partition and FreeRTOS to compile
  (`test/arduino-stubs/`). The sketch is otherwise only ever built by the Arduino IDE on
  someone else's machine, so a name collision in it is found by whoever is trying to flash
  their head. Nothing here runs and it cannot catch a real API mismatch with the ESP32 core
  - it catches our own typos, collisions and signatures. It also compiles
  `ProtoShadeParallel.cpp`, which is `#if`-guarded to ESP32 and invisible to every other
  check here. Compiled as `gnu++11`, the older core's standard, because it is the stricter one.
- `test/serial.test.mjs` - the frame parser and the USB flash protocol: text mixed into the stream, a magic
  appearing inside a log line, an impossible header, a truncated frame, one byte at a time,
  and **every possible split point** of a two-frame stream. A chunk boundary landing
  mid-header happens once in a thousand reads on real hardware and is trivial to write down
  here.
- `test/render.cpp` - renders a `.bin` to raw RGB on stdout. Used by the cross-check, handy
  on its own when a shader looks wrong.
