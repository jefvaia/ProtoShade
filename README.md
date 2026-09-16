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

`npm run build` minifies all three outputs; `npm run build:dev` skips minification
and emits a JS sourcemap. Types are checked with `npm run typecheck`.
