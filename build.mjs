// Bundles src/ into dist/ and copies static/ alongside it. Load dist/ as the unpacked extension.
import * as esbuild from "esbuild";
import { cp, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");

await rm("dist", { recursive: true, force: true });
await cp("static", "dist", { recursive: true });

const ctx = await esbuild.context({
  entryPoints: ["src/background.ts", "src/content.ts", "src/options.ts"],
  outdir: "dist",
  bundle: true,
  format: "iife", // content scripts can't be ES modules
  target: "chrome120",
  // The SDK client registers every API resource, so it can't be tree-shaken; minify and map instead.
  minify: !watch,
  sourcemap: "linked",
  logLevel: "info"
});

if (watch) await ctx.watch();
else { await ctx.rebuild(); await ctx.dispose(); }
