// Bundle every Lambda entry into packages/api/dist (one .mjs per handler file) for sam deploy.
import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("packages/api/dist", { recursive: true, force: true });
await build({
  entryPoints: ["requests", "collector", "impact", "dispatch", "postConfirmation", "admin", "assistant", "customAuth"].map((n) => `packages/api/src/handlers/${n}.ts`),
  outdir: "packages/api/dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  // ESM bundles of CJS deps need a require shim.
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
