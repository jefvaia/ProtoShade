// Builds web/ into dist/ : TypeScript -> JS, Tailwind -> CSS, HTML copied.
// Everything is minified unless --no-minify is passed.
// Output lands next to dist/protoshade.js + dist/protoshade.wasm from build.bat.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as esbuild from "esbuild";
import { minify as minifyHtml } from "html-minifier-terser";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "web");
const out = join(root, "dist");
const minify = !process.argv.includes("--no-minify");

mkdirSync(out, { recursive: true });

// 1. TypeScript -> one ES module. protoshade.js stays external: it is emitted by
// build.bat (em++) and loaded from dist/ at runtime, not bundled in here.
await esbuild.build({
  entryPoints: [join(src, "main.ts")],
  outfile: join(out, "main.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  external: ["./protoshade.js"],
  minify,
  legalComments: "none",
  sourcemap: !minify,
  logLevel: "info",
});

// 2. Tailwind -> CSS. Its own --minify is the only CSS minifier we need.
const require = createRequire(import.meta.url);
const tailwindPkg = require.resolve("@tailwindcss/cli/package.json");
const tailwind = join(dirname(tailwindPkg), require(tailwindPkg).bin.tailwindcss);
const css = spawnSync(
  process.execPath,
  [tailwind, "-i", join(src, "styles.css"), "-o", join(out, "styles.css"), ...(minify ? ["--minify"] : [])],
  { stdio: "inherit" },
);
if (css.status !== 0) process.exit(css.status ?? 1);

// 3. HTML.
const html = readFileSync(join(src, "index.html"), "utf8");
writeFileSync(
  join(out, "index.html"),
  minify
    ? await minifyHtml(html, {
        collapseWhitespace: true,
        collapseBooleanAttributes: true,
        removeComments: true,
        removeRedundantAttributes: true,
        removeAttributeQuotes: true,
        useShortDoctype: true,
        sortAttributes: true,
        sortClassName: true,
        minifyCSS: true,
        minifyJS: true,
      })
    : html,
);

console.log(`done: dist/index.html + dist/main.js + dist/styles.css${minify ? " (minified)" : ""}`);
