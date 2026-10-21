import { defineConfig } from "tsup";

// tsup bundles the JavaScript for both module systems:
//   dist/index.js  (ESM: import)   and   dist/index.cjs  (CommonJS: require)
// Type files (.d.ts) come from `tsc`, because TypeScript 7 has no JS API for tsup's dts step.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "neutral", // runs in Node and in browsers
  target: "es2022",
  sourcemap: true,
  clean: true,
  dts: false,
});
