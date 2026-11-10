#!/usr/bin/env node
// Bundles every manifest-referenced entry point into dist/, mirroring each
// file's src/ path. Pass --watch for incremental rebuilds.
//
// Two formats, matching how each entry is actually loaded:
// - ESM: the background service worker ("type": "module" in manifest.json)
//   and each dashboard/onboarding page's <script type="module" src>.
// - IIFE: content.ts (content scripts can't be ES modules here — manifest's
//   content_scripts has no "type": "module") and theme.ts (loaded via a
//   plain blocking <script src>, before any module script runs).
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const esmBuild = {
  entryPoints: [
    "src/background/background.ts",
    "src/dashboard/dashboard.ts",
    "src/dashboard/dashboard-full.ts",
    "src/onboarding/onboarding.ts",
    "src/onboarding/login.ts",
    "src/onboarding/signup.ts",
    "src/onboarding/reset-password.ts",
    "src/settings/settings.ts",
  ],
  format: "esm" as const,
};

const iifeBuild = {
  entryPoints: ["src/content/content.ts", "src/shared/theme.ts"],
  format: "iife" as const,
};

const contexts = await Promise.all(
  [esmBuild, iifeBuild].map(({ entryPoints, format }) =>
    esbuild.context({
      entryPoints,
      outdir: "dist",
      outbase: "src",
      bundle: true,
      format,
      target: "es2022",
      sourcemap: true,
      logLevel: "info",
    }),
  ),
);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("Watching for changes...");
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
