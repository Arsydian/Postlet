/**
 * @file vitest.config.ts
 * @description Vitest configuration running unit & integration tests inside Cloudflare's `workerd`
 * runtime via `@cloudflare/vitest-plugin`, backed by real local Miniflare D1 and R2 bindings.
 */
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        wrangler: {
          configPath: "./wrangler.test.jsonc",
        },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./tests/apply-migrations.ts"],
    },
  };
});
