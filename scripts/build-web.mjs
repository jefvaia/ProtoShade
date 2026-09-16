// Builds web/ into dist/ : TypeScript -> JS, Tailwind -> CSS, HTML copied.
// Everything is minified unless --no-minify is passed.
// Output lands next to dist/protoshade.js + dist/protoshade.wasm from build.bat.
//
//   --no-minify   readable output + JS sourcemap
//   --watch       rebuild on change, serve dist/ over HTTP, reload the browser
//   --port <n>    dev server port (default 8000)
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize } from "node:path";

import * as esbuild from "esbuild";
import { minify as minifyHtml } from "html-minifier-terser";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "web");
const out = join(root, "dist");
const args = process.argv.slice(2);
const watch = args.includes("--watch");
const minify = !watch && !args.includes("--no-minify");
const port = Number(args[args.indexOf("--port") + 1]) || 8000;

const htmlIn = join(src, "index.html");
const cssIn = join(src, "styles.css");
const vendorIn = join(src, "vendor");

mkdirSync(out, { recursive: true });

// Third-party files that ship as-is. The CSS is pulled in by styles.css and the .d.ts is
// types only, so only what the page actually requests at runtime gets copied.
function copyVendor() {
  if (!existsSync(vendorIn)) return;
  for (const name of readdirSync(vendorIn)) {
    if (name.endsWith(".css") || name.endsWith(".d.ts")) continue;
    cpSync(join(vendorIn, name), join(out, "vendor", name), { recursive: true });
  }
}

// Tailwind -> CSS. Its own --minify is the only CSS minifier we need.
// ponytail: one-shot per rebuild (~40ms) instead of `tailwindcss --watch`, so there is
// no second long-running process and the CSS is always on disk before the page reloads.
// Upgrade path if it ever gets slow: back to --watch, and delay the reload until it writes.
const require = createRequire(import.meta.url);
const tailwindPkg = require.resolve("@tailwindcss/cli/package.json");
const tailwindBin = join(dirname(tailwindPkg), require(tailwindPkg).bin.tailwindcss);
function buildCss() {
  const css = spawnSync(
    process.execPath,
    [tailwindBin, "-i", cssIn, "-o", join(out, "styles.css"), ...(minify ? ["--minify"] : [])],
    { stdio: "inherit" },
  );
  if (css.status !== 0 && !watch) process.exit(css.status ?? 1);
}

// HTML. In watch mode the page subscribes to /__reload and reloads after every rebuild.
const RELOAD = `<script>new EventSource("/__reload").onmessage=()=>location.reload()</script>`;
async function buildHtml() {
  const html = readFileSync(htmlIn, "utf8");
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
      : watch
        ? html.replace("</body>", `${RELOAD}</body>`)
        : html,
  );
}

// TypeScript -> one ES module. protoshade.js stays external: it is emitted by
// build.bat (em++) and loaded from dist/ at runtime, not bundled in here.
// index.html and styles.css are declared as watch inputs, so editing either one
// triggers a rebuild - and with it the CSS, the HTML copy and the browser reload.
const config = {
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
  plugins: [
    {
      name: "protoshade-web",
      setup(build) {
        build.onLoad({ filter: /main\.ts$/ }, (file) => ({
          contents: readFileSync(file.path, "utf8"),
          loader: "ts",
          watchFiles: [
            htmlIn,
            cssIn,
            ...(existsSync(vendorIn) ? readdirSync(vendorIn).map((name) => join(vendorIn, name)) : []),
          ],
        }));
        build.onEnd(async () => {
          copyVendor();
          buildCss();
          await buildHtml();
          reload();
        });
      },
    },
  ],
};

// Dev server: static files out of dist/ plus an SSE endpoint the page listens on.
// esbuild's own serve/live-reload only fires when its bundle changes, so a CSS- or
// HTML-only edit would never reach the browser; this fires on every rebuild.
const clients = new Set();
function reload() {
  for (const res of clients) res.write("data: reload\n\n");
}

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

function serve() {
  createServer((req, res) => {
    if (req.url === "/__reload") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    // normalize() strips ../ so a request cannot escape dist/.
    const file = join(out, normalize(req.url === "/" ? "/index.html" : req.url.split("?")[0]));
    let body;
    try {
      body = readFileSync(file);
    } catch {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  }).listen(port, () => console.log(`\nwatching web/ - http://localhost:${port}/  (ctrl-c to stop)`));
}

if (!watch) {
  await esbuild.build(config);
  console.log(`done: dist/index.html + dist/main.js + dist/styles.css${minify ? " (minified)" : ""}`);
} else {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  serve();

  if (!existsSync(join(out, "protoshade.js"))) {
    console.warn("warning: dist/protoshade.js is missing - run build.bat (em++) or the page will 404");
  }
}
