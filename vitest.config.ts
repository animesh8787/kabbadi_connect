import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["packages/{shared,api}/test/**/*.test.ts"] } });
