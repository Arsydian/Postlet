/**
 * @file tests/apply-migrations.ts
 * @description Applies D1 SQL migrations to the isolated local test database before each test file.
 */
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

beforeAll(async () => {
  const testEnv = env as unknown as { DB: D1Database; TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});
