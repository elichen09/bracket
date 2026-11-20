// Builds coda for the desktop app: desktop/main.tsx and everything it reaches,
// bundled into desktop/dist (index.html, app.js, app.css, the fonts), which
// src-tauri ships inside the app. Run from the repo root: node desktop/build.mjs
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: { app: join(here, "main.tsx") },
  outdir: out,
  bundle: true,
  format: "esm",
  splitting: false,
  minify: true,
  sourcemap: false,
  target: ["chrome110", "safari15"],
  jsx: "automatic",
  tsconfig: join(root, "tsconfig.json"),
  alias: { "next/link": join(here, "shims/link.tsx") },
  loader: { ".woff2": "file", ".png": "file", ".svg": "file" },
  assetNames: "fonts/[name]",
  // nothing on the desktop reads these; the web build fills them in
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.NEXT_PUBLIC_SUPABASE_URL": '""',
    "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": '""',
    "process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID": '""',
  },
  logLevel: "info",
});

copyFileSync(join(here, "index.html"), join(out, "index.html"));
cpSync(join(here, "fonts"), join(out, "fonts"), { recursive: true });
console.log("desktop/dist ready");
