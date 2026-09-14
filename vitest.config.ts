import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests live next to the code under `src/`. The Playwright E2E specs in
 * `e2e/` use a different runner, so they're excluded here to avoid Vitest
 * trying to execute them.
 *
 * `server-only` is Next's build-time guard (a transitive dep, unresolvable
 * under plain Node) — aliased to an empty module so PURE exports of server
 * modules stay unit-testable. `@/` mirrors the tsconfig path alias.
 */
export default defineConfig({
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./scripts/empty.mjs", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
  },
});
