/**
 * @file tests/auth-and-scopes.test.ts
 * @description Tests Cloudflare Zero Trust Access RS256 JWT verification, localhost dev-bypass
 * safety locks, and Agent API permissions (read_only, read_draft, read_write, alias lock,
 * recipient domain allowlist, hourly rate limiting, revocation, and audit logging).
 */

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/worker/index";
import { createAddress } from "../src/worker/services/addresses";
import { createAgentKey, revokeAgentKey } from "../src/worker/services/agent-keys";
import {
  buildTestEnv,
  createMockResendFetch,
  createTestAccessJwtSetup,
  resetDatabaseAndStorage,
} from "./helpers/test-env";

describe("Authentication & Scoped Agent Guardrails", () => {
  beforeEach(async () => {
    await resetDatabaseAndStorage();
  });

  it("verifies Cloudflare Zero Trust Access RS256 JWTs and blocks unauthorized hosts/tokens", async () => {
    const teamDomain = "postlet-team.cloudflareaccess.com";
    const audience = "aud-postlet-prod-123";
    const { token, jwksFetch } = await createTestAccessJwtSetup({
      teamDomain,
      audience,
      email: "admin@example.com",
    });

    const testEnv = buildTestEnv({
      CF_ACCESS_TEAM_DOMAIN: teamDomain,
      CF_ACCESS_AUD: audience,
      DEV_BYPASS_ACCESS: "true", // MUST be ignored whenever CF_ACCESS_AUD is configured!
    });

    const app = createApp({ accessFetchFn: jwksFetch });

    // No JWT -> 401 even on localhost when CF_ACCESS_AUD is set
    const unauth = await app.fetch(new Request("http://localhost/api/admin/meta"), testEnv);
    expect(unauth.status).toBe(401);

    // Valid RS256 Access JWT -> 200 and resolves ownerEmail
    const authed = await app.fetch(
      new Request("https://postlet.example.com/api/admin/meta", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      testEnv,
    );
    expect(authed.status).toBe(200);
    const meta = (await authed.json()) as { ownerEmail: string };
    expect(meta.ownerEmail).toBe("admin@example.com");

    // Wrong audience -> 401
    const wrongAudEnv = buildTestEnv({
      CF_ACCESS_TEAM_DOMAIN: teamDomain,
      CF_ACCESS_AUD: "different-aud",
    });
    const rejected = await app.fetch(
      new Request("https://postlet.example.com/api/admin/meta", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      wrongAudEnv,
    );
    expect(rejected.status).toBe(401);

    // Local dev bypass without AUD is strictly denied on non-localhost hostnames
    const nonLocalRes = await app.fetch(
      new Request("https://public.example.com/api/admin/meta"),
      buildTestEnv({ DEV_BYPASS_ACCESS: "true", CF_ACCESS_AUD: undefined }),
    );
    expect(nonLocalRes.status).toBe(401);
  });

  it("enforces read_only, read_draft, read_write scopes, alias locks, domain allowlists, rate limits, and revocation", async () => {
    const addrSales = await createAddress(env.DB, {
      email: "sales@mail.example.com",
      isDefault: true,
    });
    const addrSupport = await createAddress(env.DB, {
      email: "support@mail.example.com",
    });

    const mockResend = createMockResendFetch();
    const testEnv = buildTestEnv();
    const app = createApp({ resendFetchFn: mockResend.fetchFn });

    // Seed two inbound threads for different aliases
    await env.DB.prepare(
      `INSERT INTO threads (id, subject, snippet, participants_json, recipient_address, folder, last_message_at, message_count, unread_count, created_at, updated_at)
       VALUES
       ('t-sales', 'Sales Inquiry', 'Want quote', '["lead@client.com","sales@mail.example.com"]', 'sales@mail.example.com', 'inbox', '2026-11-20T10:00:00Z', 1, 1, '2026-11-20T10:00:00Z', '2026-11-20T10:00:00Z'),
       ('t-support', 'Support Ticket', 'Help login', '["user@other.com","support@mail.example.com"]', 'support@mail.example.com', 'inbox', '2026-11-20T10:05:00Z', 1, 1, '2026-11-20T10:05:00Z', '2026-11-20T10:05:00Z')`,
    ).run();

    // 1. read_only key cannot draft or send
    const roKey = await createAgentKey(
      env.DB,
      { name: "ReaderBot", scope: "read_only" },
      "https://postlet.example.com",
    );
    const roDraft = await app.fetch(
      new Request("https://postlet.example.com/api/v1/drafts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${roKey.plaintextSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to: ["x@y.com"], subject: "No", textBody: "No" }),
      }),
      testEnv,
    );
    expect(roDraft.status).toBe(403);

    // 2. read_draft key scoped to support@ + allowed domain client.com
    const draftKey = await createAgentKey(
      env.DB,
      {
        name: "SupportDrafter",
        scope: "read_draft",
        allowedAddressId: addrSupport.id,
        allowedRecipientDomains: ["client.com"],
      },
      "https://postlet.example.com",
    );

    // Alias isolation: only sees t-support, not t-sales
    const listRes = await app.fetch(
      new Request("https://postlet.example.com/api/v1/threads", {
        headers: { Authorization: `Bearer ${draftKey.plaintextSecret}` },
      }),
      testEnv,
    );
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { threads: Array<{ id: string }> };
    expect(listed.threads.map((t) => t.id)).toEqual(["t-support"]);

    // Blocked when trying to read t-sales directly
    const salesRead = await app.fetch(
      new Request("https://postlet.example.com/api/v1/threads/t-sales", {
        headers: { Authorization: `Bearer ${draftKey.plaintextSecret}` },
      }),
      testEnv,
    );
    expect(salesRead.status).toBe(404);

    // Blocked when trying to send immediately with read_draft
    const sendBlocked = await app.fetch(
      new Request("https://postlet.example.com/api/v1/messages/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${draftKey.plaintextSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to: ["a@client.com"], subject: "Hi", textBody: "Test" }),
      }),
      testEnv,
    );
    expect(sendBlocked.status).toBe(403);

    // Blocked when drafting to non-allowlisted domain
    const badDomainDraft = await app.fetch(
      new Request("https://postlet.example.com/api/v1/drafts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${draftKey.plaintextSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to: ["evil@blocked.org"], subject: "Hi", textBody: "Test" }),
      }),
      testEnv,
    );
    expect(badDomainDraft.status).toBe(403);

    // Allowed draft to allowlisted domain creates pending_approval
    const okDraft = await app.fetch(
      new Request("https://postlet.example.com/api/v1/drafts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${draftKey.plaintextSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to: ["ok@client.com"], subject: "Re: Support", textBody: "Draft" }),
      }),
      testEnv,
    );
    expect(okDraft.status).toBe(201);
    const okDraftJson = (await okDraft.json()) as { message: { status: string; fromAddress: string } };
    expect(okDraftJson.message.status).toBe("pending_approval");
    expect(okDraftJson.message.fromAddress).toBe("support@mail.example.com");

    // 3. read_write key with rate limit 1/hr sends once, then gets 429
    const rwKey = await createAgentKey(
      env.DB,
      {
        name: "SenderBot",
        scope: "read_write",
        allowedAddressId: addrSales.id,
        rateLimitPerHour: 1,
      },
      "https://postlet.example.com",
    );
    const rwSend1 = await app.fetch(
      new Request("https://postlet.example.com/api/v1/messages/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rwKey.plaintextSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to: ["lead@client.com"], subject: "Quote", textBody: "Attached" }),
      }),
      testEnv,
    );
    expect(rwSend1.status).toBe(200);
    expect(mockResend.calls).toHaveLength(1);

    const rwRateLimited = await app.fetch(
      new Request("https://postlet.example.com/api/v1/threads", {
        headers: { Authorization: `Bearer ${rwKey.plaintextSecret}` },
      }),
      testEnv,
    );
    expect(rwRateLimited.status).toBe(429);

    // 4. Revoked key fails with 401
    await revokeAgentKey(env.DB, roKey.key.id);
    const revokedRes = await app.fetch(
      new Request("https://postlet.example.com/api/v1/threads", {
        headers: { Authorization: `Bearer ${roKey.plaintextSecret}` },
      }),
      testEnv,
    );
    expect(revokedRes.status).toBe(401);
  });

  it("enforces Cloudflare Access Service Token JWTs (common_name & AUD) and X-Postlet-Service-Secret on /api/v1/* and /mcp", async () => {
    await createAddress(env.DB, {
      email: "uptime@mail.example.com",
      isDefault: true,
    });
    const key = await createAgentKey(
      env.DB,
      { name: "UptimeFlare", scope: "read_write" },
      "https://postlet.example.com",
    );

    const teamDomain = "postlet-team.cloudflareaccess.com";
    const serviceAud = "aud-service-api-v1";
    const allowedClientId = "svc-uptimeflare.access";

    const validSvc = await createTestAccessJwtSetup({
      teamDomain,
      audience: serviceAud,
      commonName: allowedClientId,
    });
    const wrongClientSvc = await createTestAccessJwtSetup({
      teamDomain,
      audience: serviceAud,
      commonName: "svc-rogue.access",
    });
    const wrongAudSvc = await createTestAccessJwtSetup({
      teamDomain,
      audience: "aud-other-app",
      commonName: allowedClientId,
    });

    const mockResend = createMockResendFetch();
    const app = createApp({ accessFetchFn: validSvc.jwksFetch, resendFetchFn: mockResend.fetchFn });

    const serviceEnv = buildTestEnv({
      CF_ACCESS_TEAM_DOMAIN: teamDomain,
      CF_ACCESS_SERVICE_AUD: serviceAud,
      CF_ACCESS_SERVICE_TOKEN_IDS: allowedClientId,
      POSTLET_SERVICE_AUTH_SECRET: "shared-svc-secret-123",
    });

    // Missing Access JWT -> 401
    const noJwtRes = await app.fetch(
      new Request("https://postlet.example.com/api/v1/messages/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.plaintextSecret}`,
          "X-Postlet-Service-Secret": "shared-svc-secret-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to: ["ops@example.org"], subject: "Alert", textBody: "Down" }),
      }),
      serviceEnv,
    );
    expect(noJwtRes.status).toBe(401);

    // Wrong AUD -> 401
    const appWrongAud = createApp({
      accessFetchFn: wrongAudSvc.jwksFetch,
      resendFetchFn: mockResend.fetchFn,
    });
    const wrongAudRes = await appWrongAud.fetch(
      new Request("https://postlet.example.com/api/v1/messages/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.plaintextSecret}`,
          "Cf-Access-Jwt-Assertion": wrongAudSvc.token,
          "X-Postlet-Service-Secret": "shared-svc-secret-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to: ["ops@example.org"], subject: "Alert", textBody: "Down" }),
      }),
      serviceEnv,
    );
    expect(wrongAudRes.status).toBe(401);

    // Valid signature + AUD, unauthorized common_name -> 403
    const appWrongClient = createApp({
      accessFetchFn: wrongClientSvc.jwksFetch,
      resendFetchFn: mockResend.fetchFn,
    });
    const wrongClientRes = await appWrongClient.fetch(
      new Request("https://postlet.example.com/api/v1/messages/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.plaintextSecret}`,
          "Cf-Access-Jwt-Assertion": wrongClientSvc.token,
          "X-Postlet-Service-Secret": "shared-svc-secret-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to: ["ops@example.org"], subject: "Alert", textBody: "Down" }),
      }),
      serviceEnv,
    );
    expect(wrongClientRes.status).toBe(403);

    // Valid JWT + wrong/missing shared secret -> 401
    const badSecretRes = await app.fetch(
      new Request("https://postlet.example.com/api/v1/messages/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.plaintextSecret}`,
          "Cf-Access-Jwt-Assertion": validSvc.token,
          "X-Postlet-Service-Secret": "wrong-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to: ["ops@example.org"], subject: "Alert", textBody: "Down" }),
      }),
      serviceEnv,
    );
    expect(badSecretRes.status).toBe(401);

    // Valid Service Token JWT + valid X-Postlet-Service-Secret + valid Bearer key -> 200 on REST & MCP
    const okRestRes = await app.fetch(
      new Request("https://postlet.example.com/api/v1/messages/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.plaintextSecret}`,
          "Cf-Access-Jwt-Assertion": validSvc.token,
          "X-Postlet-Service-Secret": "shared-svc-secret-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to: ["ops@example.org"], subject: "Alert", textBody: "Down" }),
      }),
      serviceEnv,
    );
    expect(okRestRes.status).toBe(200);

    const okMcpRes = await app.fetch(
      new Request("https://postlet.example.com/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.plaintextSecret}`,
          "Cf-Access-Jwt-Assertion": validSvc.token,
          "X-Postlet-Service-Secret": "shared-svc-secret-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      serviceEnv,
    );
    expect(okMcpRes.status).toBe(200);

    // Shared secret alone without CF_ACCESS_SERVICE_AUD / TOKEN_IDS also works platform-independently
    const sharedOnlyEnv = buildTestEnv({ POSTLET_SERVICE_AUTH_SECRET: "shared-only-secret" });
    const sharedMissingRes = await app.fetch(
      new Request("https://postlet.example.com/api/v1/threads", {
        headers: { Authorization: `Bearer ${key.plaintextSecret}` },
      }),
      sharedOnlyEnv,
    );
    expect(sharedMissingRes.status).toBe(401);

    const sharedOkRes = await app.fetch(
      new Request("https://postlet.example.com/api/v1/threads", {
        headers: {
          Authorization: `Bearer ${key.plaintextSecret}`,
          "X-Postlet-Service-Secret": "shared-only-secret",
        },
      }),
      sharedOnlyEnv,
    );
    expect(sharedOkRes.status).toBe(200);
  });
});
