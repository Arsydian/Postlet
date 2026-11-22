/**
 * @file tests/helpers/test-env.ts
 * @description Shared test utilities for resetting D1/R2 state, creating cryptographically
 * signed Resend Svix webhooks, minting real RS256 Cloudflare Access JWTs, and mocking
 * Resend API and Cloudflare Workers AI responses.
 */

import { env } from "cloudflare:workers";
import { vi } from "vitest";
import type { PostletEnv } from "../../src/worker/env";
import { bytesToBase64, encodeBase64Url } from "../../src/worker/lib/crypto";

const textEncoder = new TextEncoder();

/**
 * Clears all mutable tables in D1 and restores default `app_settings` (with `ai_enabled = 'false'`),
 * keeping schema and FTS5 triggers intact for fast test isolation.
 */
export async function resetDatabaseAndStorage(): Promise<void> {
  const db = env.DB;
  await db.batch([
    db.prepare(`DELETE FROM attachments`),
    db.prepare(`DELETE FROM messages`),
    db.prepare(`DELETE FROM threads`),
    db.prepare(`DELETE FROM agent_audit_logs`),
    db.prepare(`DELETE FROM agent_keys`),
    db.prepare(`DELETE FROM addresses`),
    db.prepare(`DELETE FROM ai_digests`),
    db.prepare(`DELETE FROM app_settings`),
  ]);

  // Re-seed default settings so every test starts cleanly with AI disabled by default.
  const now = "2026-01-01T00:00:00.000Z";
  const defaults: Array<[string, string]> = [
    ["mail_domain", "mail.example.com"],
    ["catch_all_enabled", "true"],
    ["ai_enabled", "false"],
    ["ai_model", "@cf/meta/llama-3.2-3b-instruct"],
    ["ai_daily_cap", "50"],
    ["ai_daily_count", "0"],
    ["ai_daily_date", ""],
    ["ai_auto_triage_enabled", "false"],
    ["ai_daily_summary_enabled", "false"],
    ["ai_daily_summary_hour", "8"],
    ["ai_daily_summary_timezone", "UTC"],
    ["ai_daily_summary_email_copy", "false"],
    ["ai_daily_summary_last_run_date", ""],
    ["ai_important_auto_reply_enabled", "false"],
    ["ai_important_auto_reply_mode", "approval"],
    [
      "ai_important_auto_reply_instructions",
      "Acknowledge receipt politely, confirm their message was received, and let them know I will follow up personally soon.",
    ],
    ["ai_important_auto_reply_cooldown_hours", "24"],
  ];
  const stmt = db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`);
  await db.batch(defaults.map(([k, v]) => stmt.bind(k, v, now)));

  // Clean up R2 test objects.
  const listed = await env.ATTACHMENTS.list();
  for (const obj of listed.objects) {
    await env.ATTACHMENTS.delete(obj.key);
  }
}

/**
 * Generates a real Svix HMAC-SHA256 `svix-id`, `svix-timestamp`, and `svix-signature` header set
 * for testing `/api/webhooks/resend`.
 */
export async function createSignedWebhookHeaders(
  rawBody: string,
  webhookSecret: string,
  options?: { id?: string; timestamp?: number },
): Promise<Record<string, string>> {
  const id = options?.id ?? `msg_${crypto.randomUUID()}`;
  const timestamp = String(options?.timestamp ?? Math.floor(Date.now() / 1000));
  const rawSecret = webhookSecret.startsWith("whsec_")
    ? webhookSecret.slice("whsec_".length)
    : webhookSecret;

  const secretBin = atob(rawSecret);
  const secretBytes = new Uint8Array(secretBin.length);
  for (let i = 0; i < secretBin.length; i += 1) {
    secretBytes[i] = secretBin.charCodeAt(i);
  }

  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(`${id}.${timestamp}.${rawBody}`),
  );
  const sigB64 = bytesToBase64(new Uint8Array(sigBuf));

  return {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${sigB64}`,
  };
}

/**
 * Generates an RSA-2048 keypair, signs a Cloudflare Zero Trust Access JWT, and builds a mock
 * `fetch` function serving the corresponding JWKS certs endpoint.
 */
export async function createTestAccessJwtSetup(params: {
  teamDomain: string;
  audience: string;
  email?: string;
  expOffsetSeconds?: number;
}) {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & {
    kid?: string;
    alg?: string;
    use?: string;
  };
  const kid = "test-kid-1";
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const now = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const payload = encodeBase64Url(
    JSON.stringify({
      aud: [params.audience],
      iss: `https://${params.teamDomain}`,
      exp: now + (params.expOffsetSeconds ?? 3600),
      iat: now,
      email: params.email ?? "owner@example.com",
      sub: "user-123",
    }),
  );

  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    textEncoder.encode(`${header}.${payload}`),
  );
  const token = `${header}.${payload}.${encodeBase64Url(new Uint8Array(sigBuf))}`;

  const jwksFetch: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === `https://${params.teamDomain}/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not found", { status: 404 });
  };

  return { token, jwksFetch };
}

/**
 * Creates a deterministic mock `fetch` implementing Resend's send, receiving get,
 * receiving attachments, and attachment binary download endpoints.
 */
export function createMockResendFetch(options?: {
  receivedEmails?: Record<string, Record<string, unknown>>;
  attachmentFiles?: Record<
    string,
    { filename: string; contentType: string; bytes: Uint8Array<ArrayBuffer> }
  >;
  onSend?: (payload: Record<string, unknown>) => void;
}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let sendSeq = 0;

  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();

    if (url === "https://api.resend.com/emails" && method === "POST") {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, method, body: parsed });
      options?.onSend?.(parsed);
      sendSeq += 1;
      return Response.json({ id: `re_sent_${sendSeq}` }, { status: 200 });
    }

    const receiveMatch = url.match(/^https:\/\/api\.resend\.com\/emails\/receiving\/([^/]+)$/);
    if (receiveMatch && method === "GET") {
      const emailId = decodeURIComponent(receiveMatch[1]);
      calls.push({ url, method });
      const email = options?.receivedEmails?.[emailId];
      if (!email) {
        return new Response("Not found", { status: 404 });
      }
      return Response.json(email, { status: 200 });
    }

    const attListMatch = url.match(
      /^https:\/\/api\.resend\.com\/emails\/receiving\/([^/]+)\/attachments$/,
    );
    if (attListMatch && method === "GET") {
      calls.push({ url, method });
      const items = Object.entries(options?.attachmentFiles ?? {}).map(([attId, file]) => ({
        id: attId,
        filename: file.filename,
        content_type: file.contentType,
        size: file.bytes.byteLength,
        download_url: `https://mock-resend-cdn.local/att/${attId}`,
      }));
      return Response.json({ data: items }, { status: 200 });
    }

    const attDownloadMatch = url.match(/^https:\/\/mock-resend-cdn\.local\/att\/([^/]+)$/);
    if (attDownloadMatch) {
      calls.push({ url, method });
      const att = options?.attachmentFiles?.[attDownloadMatch[1]];
      if (!att) return new Response("Missing", { status: 404 });
      return new Response(att.bytes, {
        status: 200,
        headers: {
          "Content-Type": att.contentType,
          "Content-Length": String(att.bytes.byteLength),
        },
      });
    }

    return new Response(`Unhandled mock fetch: ${method} ${url}`, { status: 500 });
  };

  return { fetchFn, calls };
}

/**
 * Creates a deterministic Workers AI mock (`env.AI.run`) tracking invocations.
 */
export function createMockWorkersAi(
  responder?: (model: string, input: Record<string, unknown>) => unknown,
) {
  const run = vi.fn(async (model: string, input: Record<string, unknown>) => {
    if (responder) {
      return responder(model, input);
    }
    return { response: "Mock AI summary response" };
  });
  return { run };
}

/**
 * Builds a complete `PostletEnv` object merging real local Miniflare D1/R2 bindings
 * with test secrets and optional mock Workers AI.
 */
export function buildTestEnv(overrides?: Partial<PostletEnv>): PostletEnv {
  const base = env as unknown as PostletEnv;
  return {
    ...base,
    APP_NAME: "Postlet",
    APP_VERSION: "0.1.3",
    DEFAULT_AI_MODEL: "@cf/meta/llama-3.2-3b-instruct",
    RESEND_API_KEY: "re_test_key",
    RESEND_WEBHOOK_SECRET: `whsec_${btoa("supersecretkey1234567890")}`,
    MAIL_DOMAIN: "mail.example.com",
    DEV_BYPASS_ACCESS: "true",
    ...overrides,
  };
}
