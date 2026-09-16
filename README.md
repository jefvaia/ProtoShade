# ProtoShade

`src/ProtoShadeRuntime.{h,cpp}` is the portable core (no Arduino.h, no emscripten).
It runs on the ESP32-S3 as an Arduino library and in the browser via wasm.

## Build

Two independent builds, both writing into `dist/`:

```
build.bat              # em++: runs test/test.cpp, then emits dist/protoshade.js + .wasm
npm install
npm run build          # tsc typecheck + minified dist/index.html, main.js, styles.css
```

Serve `dist/` over HTTP (not `file://` — it is an ES module) and open `index.html`.

## Website

Plain HTML + Tailwind v4 + TypeScript, no framework:

- `web/index.html` — markup, Tailwind utility classes
- `web/main.ts` — canvas loop, imports the wasm module
- `web/styles.css` — `@import "tailwindcss"` + `@source` scan list
- `web/protoshade.d.ts` — hand-written types for the emscripten glue
- `web/vendor/` — third-party files, committed (no CDN: the ESP32 has no internet)

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
