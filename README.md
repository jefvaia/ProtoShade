# ProtoShade

`src/ProtoShadeRuntime.{h,cpp}` is the portable core (no Arduino.h, no emscripten).
It runs on the ESP32-S3 as an Arduino library and in the browser via wasm.

## Runtime

The core takes a `.bin` container, renders at a chosen resolution, and samples pixels.
No shader VM yet — `sample()` returns a built-in test pattern until one lands.

```cpp
protoshade::ProtoShadeRuntime rt;
rt.load(blob, len);              // validates the whole container, does NOT copy it
rt.setResolution(64, 32);

protoshade::ExecContext ctx;     // one per thread, never shared
const auto frame = rt.beginFrame(millis());
rt.renderRows(ctx, frame, 0, 16, buffer);   // rows [0,16) -> this is a core's unit of work
```

Threading lives outside the core: wasm has no FreeRTOS, so the core cannot spawn tasks.
It exposes `renderRows()` and the platform splits the frame. `sample()` is `const` and
keeps no shared mutable state, so two cores can run it at once — per-frame values come in
as an immutable `Frame`, per-thread scratch as a caller-owned `ExecContext`.

`src/ProtoShadeParallel.{h,cpp}` is the ESP32 half of that: two tasks pinned to core 0 and
core 1, each rendering half the frame. It is the only non-portable file, `#if`-guarded so
every other target skips it.

### The .bin container

One file holds everything the device needs — program code plus assets (PNGs converted to
raw RGB565 by the web app; the ESP32 never decodes PNG). Layout is documented at the top of
`ProtoShadeRuntime.h`; `test/test.cpp` builds one byte by byte and is the arbiter if the
packer and the runtime ever disagree.

It belongs in a **flash** partition, not RTC memory — RTC RAM is 8 KB and is lost on power
loss. `esp_partition_mmap()` maps it into the address space, which is why `load()` borrows
the bytes instead of copying them: the assets then cost no RAM. The blob must outlive the
runtime, so never overwrite the partition you are rendering from.

Everything a program declares is bounds-checked at `load()`, and `ExecContext::step_limit`
caps work per pixel. Both matter because the `.bin` arrives from a web page: untrusted
input, running on hardware strapped to someone's head.

## Build

Two independent builds, both writing into `dist/`:

```
build.bat              # em++: runs test/test.cpp, then emits dist/protoshade.js + .wasm
npm install
npm run build          # typecheck + npm test + minified dist/index.html, main.js, styles.css
```

Serve `dist/` over HTTP (not `file://` — it is an ES module) and open `index.html`.

## Website

Plain HTML + Tailwind v4 + TypeScript, no framework:

- `web/index.html` — markup, Tailwind utility classes
- `web/main.ts` — page wiring: editor, resolution, preview loop
- `web/nodes.ts` — the node library (definitions + litegraph registration)
- `web/graph.ts` — compiles a node graph into a per-pixel function
- `web/styles.css` — `@import "tailwindcss"` + `@source` scan list
- `web/protoshade.d.ts` — hand-written types for the emscripten glue
- `web/vendor/` — third-party files, committed (no CDN: the ESP32 has no internet)

### The shader editor

A Blender-style node graph (litegraph) on the left, an LED-matrix preview on the right.
Set the panel resolution in the header — free text, clamped to 1..512 per side, which is
the container's `kMaxDimension`. Right-click the canvas to add a node.

Every value is **RGBA**: a plain number broadcasts to `[n, n, n, 1]` (opaque), and a node
that wants a single number reads R. One type means no coercion rules to remember, and
alpha survives all the way from an uploaded PNG to the `Alpha Over` node. `LED Output`
flattens alpha against black — the panel has nothing behind it.

Nodes: `Coordinates` (UV / centered / pixel), `Time`, `Value`, `Color`, `Math` (20
component-wise ops), `Mix`, `Alpha Over`, `Separate`/`Combine RGBA`, `HSV`, `Image`
(uploads a PNG/JPG, downscaled to 512px, sampled nearest or linear, repeat or clamp) and
`LED Output`. An unconnected input falls back to the node's own widget.

The graph autosaves to `localStorage` (uploads included, as data URLs) and reloads with
the page. "reset graph" puts the starter graph back.

Today the preview evaluates the graph **in TypeScript** — the runtime has no shader VM
yet, so the wasm module is only probed for presence ("device runtime: loaded / not
built"). When the VM lands, the page packs a `.bin` and this evaluator becomes the
reference the wasm output is checked against, so keep the two honest:
`npm test` runs `test/graph-eval.test.mjs`, which compiles graph literals and asserts the
maths, the alpha compositing, the guarded ops (divide by zero, negative sqrt) and that a
cycle neither hangs nor crashes. `npm run build` runs it.

### Adding a vendor file

- **JS**: drop it in `web/vendor/` and `import` it from `main.ts` so esbuild bundles it.
  If it is a classic/UMD script that reaches the global object (litegraph does, via
  `})(this)`), that breaks in a module — add a `<script>` tag to `index.html` instead;
  the build copies `web/vendor/` to `dist/vendor/`. Types go in a `.d.ts` beside it.
- **CSS**: `@import "./vendor/name.css" layer(vendor);` at the top of `styles.css`, so it
  ends up in the single minified stylesheet. The `layer(vendor)` matters — unlayered
  vendor CSS beats every Tailwind utility, layered it loses to them. If the file
  references fonts or images by `url()`, link it separately instead; those paths are
  not rewritten.

`npm run build` minifies all three outputs; `npm run build:dev` skips minification
and emits a JS sourcemap. Types are checked with `npm run typecheck`.

`npm run dev` watches `web/`, rebuilds on every change and serves `dist/` on
http://localhost:8000 (`-- --port 3000` to change it). The page reloads itself
after each rebuild. Run `build.bat` once first, otherwise `protoshade.js` 404s.
