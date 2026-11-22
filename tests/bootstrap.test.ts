/**
 * @file tests/bootstrap.test.ts
 * @description Integration tests verifying zero-touch runtime D1 schema bootstrapping on an
 * empty auto-provisioned database, FTS5 triggers & index creation, idempotency across
 * isolate restarts and formal D1 migrations, and lightweight `/api/health` handling.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AdminMetaResponse } from "../src/shared/types";
import {
  INITIAL_SCHEMA_STATEMENTS,
  REQUIRED_TABLES,
  ensureDatabaseSchema,
  resetSchemaBootstrapStateForTests,
} from "../src/worker/db/bootstrap";
import { createApp } from "../src/worker/index";
import { listThreads } from "../src/worker/services/mail";
import { buildTestEnv } from "./helpers/test-env";

/** Drops all Postlet triggers and tables to simulate a freshly auto-provisioned empty D1 database. */
async function dropAllPostletSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`DROP TRIGGER IF EXISTS messages_fts_insert`),
    db.prepare(`DROP TRIGGER IF EXISTS messages_fts_update`),
    db.prepare(`DROP TRIGGER IF EXISTS messages_fts_delete`),
    db.prepare(`DROP TABLE IF EXISTS messages_fts`),
    db.prepare(`DROP TABLE IF EXISTS attachments`),
    db.prepare(`DROP TABLE IF EXISTS messages`),
    db.prepare(`DROP TABLE IF EXISTS threads`),
    db.prepare(`DROP TABLE IF EXISTS agent_audit_logs`),
    db.prepare(`DROP TABLE IF EXISTS agent_keys`),
    db.prepare(`DROP TABLE IF EXISTS addresses`),
    db.prepare(`DROP TABLE IF EXISTS ai_digests`),
    db.prepare(`DROP TABLE IF EXISTS app_settings`),
  ]);
}

describe("Automatic D1 Schema Bootstrap", () => {
  beforeEach(() => {
    resetSchemaBootstrapStateForTests();
  });

  afterAll(async () => {
    resetSchemaBootstrapStateForTests();
    await ensureDatabaseSchema(env.DB);
  });

  it("bootstraps all tables, FTS5 triggers, indexes, and defaults from an empty D1 database", async () => {
    await dropAllPostletSchema(env.DB);

    const app = createApp();
    const testEnv = buildTestEnv();
    const res = await app.fetch(new Request("http://localhost/api/admin/meta"), testEnv);

    expect(res.status).toBe(200);
    const meta = (await res.json()) as AdminMetaResponse;
    expect(meta.appVersion).toBe("0.4.0");
    expect(meta.settings.aiEnabled).toBe(false);

    // Verify all 9 tables, 3 FTS5 sync triggers, and 9 composite indexes exist.
    const tableRows = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations' AND name NOT LIKE 'messages_fts_%'`,
    ).all<{ name: string }>();
    const tableNames = new Set(tableRows.results.map((r) => r.name));
    for (const required of REQUIRED_TABLES) {
      expect(tableNames.has(required)).toBe(true);
    }

    const triggerRows = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger'`,
    ).all<{ name: string }>();
    const triggerNames = triggerRows.results.map((r) => r.name);
    expect(triggerNames).toEqual(
      expect.arrayContaining([
        "messages_fts_insert",
        "messages_fts_update",
        "messages_fts_delete",
      ]),
    );

    const indexRows = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'`,
    ).all<{ name: string }>();
    expect(indexRows.results).toHaveLength(9);

    // Insert a thread and message and confirm FTS5 insert trigger populates `messages_fts`.
    const now = "2026-11-20T12:00:00.000Z";
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO threads (id, subject, snippet, participants_json, recipient_address, folder, last_message_at, message_count, unread_count, created_at, updated_at)
           VALUES ('thr_boot_1', 'Provisioning Test', 'Auto schema verified', '["alice@example.com"]', 'me@mail.example.com', 'inbox', ?, 1, 1, ?, ?)`,
        )
        .bind(now, now, now),
      env.DB
        .prepare(
          `INSERT INTO messages (id, thread_id, direction, status, from_address, from_name, to_addresses_json, subject, text_body, folder, is_read, created_at, updated_at)
           VALUES ('msg_boot_1', 'thr_boot_1', 'inbound', 'received', 'alice@example.com', 'Alice', '["me@mail.example.com"]', 'Provisioning Test', 'Searchable zerotouchbootstrap token inside body', 'inbox', 0, ?, ?)`,
        )
        .bind(now, now),
    ]);

    const hits = await listThreads(env.DB, { q: "zerotouchbootstrap" });
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("thr_boot_1");
  });

  it("stays idempotent on initialized databases and preserves existing settings", async () => {
    await dropAllPostletSchema(env.DB);
    expect(await ensureDatabaseSchema(env.DB)).toBe(true);

    // Simulate owner enabling Cloudflare Workers AI in settings.
    await env.DB
      .prepare(`UPDATE app_settings SET value = 'true' WHERE key = 'ai_enabled'`)
      .run();

    // Cached fast-path check returns false without re-running DDL.
    expect(await ensureDatabaseSchema(env.DB)).toBe(false);

    // Cold-start simulation (cache reset) inspects sqlite_master and still returns false.
    resetSchemaBootstrapStateForTests();
    expect(await ensureDatabaseSchema(env.DB)).toBe(false);

    const row = await env.DB
      .prepare(`SELECT value FROM app_settings WHERE key = 'ai_enabled'`)
      .first<{ value: string }>();
    expect(row?.value).toBe("true");
  });

  it("allows formal D1 migrations to run cleanly on top of a runtime-bootstrapped DB", async () => {
    await dropAllPostletSchema(env.DB);
    await env.DB.prepare(`DROP TABLE IF EXISTS d1_migrations`).run();

    expect(await ensureDatabaseSchema(env.DB)).toBe(true);

    // Applying the full migration files + re-running INITIAL_SCHEMA_STATEMENTS must not error.
    const testEnv = env as unknown as {
      DB: D1Database;
      TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
    };
    await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
    await env.DB.batch(INITIAL_SCHEMA_STATEMENTS.map((sql) => env.DB.prepare(sql)));

    const applied = await env.DB
      .prepare(`SELECT name FROM d1_migrations`)
      .all<{ name: string }>();
    expect(applied.results.map((r) => r.name)).toContain("0001_initial_schema.sql");
  });

  it("responds 200 on /api/health on an empty DB without bootstrapping tables", async () => {
    await dropAllPostletSchema(env.DB);

    const app = createApp();
    const res = await app.fetch(new Request("http://localhost/api/health"), buildTestEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string; version: string };
    expect(body).toEqual({
      ok: true,
      service: "Postlet",
      version: "0.4.0",
    });

    const tableRows = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'`,
    ).first<{ count: number }>();
    expect(Number(tableRows?.count ?? 0)).toBe(0);
  });
});
