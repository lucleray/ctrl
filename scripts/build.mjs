import * as esbuild from "esbuild"

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  external: ["electron", "node-pty"],
  logLevel: "info",
}

export const configs = [
  {
    ...common,
    entryPoints: ["src/main/main.ts"],
    outfile: "dist/main.js",
    format: "esm",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  },
  { ...common, entryPoints: ["src/preload/preload.ts"], outfile: "dist/preload.cjs", format: "cjs" },
]

if (process.argv[1].endsWith("build.mjs")) {
  await Promise.all(configs.map((c) => esbuild.build(c)))
}
