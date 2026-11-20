/**
 * @file tests/security.test.ts
 * @description Security regression test suite verifying defenses against alias-lock bypass,
 * inline SVG stored XSS, cross-alias digest leakage, auto-reply allowlist/Reply-To abuse,
 * CSRF on admin cookies, rate-limit bypass, malformed email domain spoofing, cross-sender
 * thread injection, unsafe attachment URLs/sizes/filenames, atomic AI quota caps, and HTTP headers.
 */

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/worker/index";
import { createAddress, updateSettings } from "../src/worker/services/addresses";
import { createAgentKey } from "../src/worker/services/agent-keys";
import { AiQuotaExceededError, summarizeThread } from "../src/worker/services/ai";
import { storeAttachment } from "../src/worker/services/attachments";
import { ingestInboundEmail } from "../src/worker/services/mail";
import { ResendClient } from "../src/worker/services/resend";
import {
  buildTestEnv,
  createMockResendFetch,
  createMockWorkersAi,
  resetDatabaseAndStorage,
} from "./helpers/test-env";

describe("Security Hardening & Vulnerability Regression Tests", () => {
  beforeEach(async () => {
    await resetDatabaseAndStorage();
  });

  it("blocks alias-locked agent keys from bypassing via fromAddressId, cross-alias threadId/replyToMessageId, or owner staging attachments", async () => {
    const ownerAddr = await createAddress(env.DB, {
      email: "owner@mail.example.com",
      isDefault: true,
    });
    const supportAddr = await createAddress(env.DB, {
      email: "support@mail.example.com",
    });

    const mockResend = createMockResendFetch({
      receivedEmails: {
        em_priv: {
          id: "em_priv",
          from: "vip@partner.org",
          to: ["owner@mail.example.com"],
          subject: "Private Thread",
          text: "Confidential info",
          message_id: "<priv-1@partner.org>",
        },
      },
    });
    const testEnv = buildTestEnv();
    const app = createApp({ resendFetchFn: mockResend.fetchFn });
    const resendClient = new ResendClient("re_test", mockResend.fetchFn);

    const priv = await ingestInboundEmail(env.DB, env.ATTACHMENTS, resendClient, {
      email_id: "em_priv",
      from: "vip@partner.org",
      to: ["owner@mail.example.com"],
    });

    // Stage an owner attachment via the real admin upload endpoint (message_id = NULL)
    const uploadForm = new FormData();
    uploadForm.append("file", new File(["top-secret!"], "secret.txt", { type: "text/plain" }));
    const uploadRes = await app.fetch(
      new Request("http://localhost/api/admin/attachments", {
        method: "POST",
        headers: { "X-Postlet-CSRF": "1" },
        body: uploadForm,
      }),
      testEnv,
    );
    expect(uploadRes.status).toBe(201);
    const { attachment: staged } = (await uploadRes.json()) as {
      attachment: { id: string; messageId: string | null };
    };
    expect(staged.messageId).toBeNull();

    const scopedKey = await createAgentKey(
      env.DB,
      {
        name: "ScopedWriter",
        scope: "read_write",
        allowedAddressId: supportAddr.id,
      },
      "https://postlet.example.com",
    );

    const unscopedKey = await createAgentKey(
      env.DB,
      {
        name: "UnscopedReader",
        scope: "read_only",
      },
      "https://postlet.example.com",
    );

    // 1. Supplying ownerAddr.id via fromAddressId must NOT send as owner@mail.example.com
    const sendRes = await app.fetch(
      new Request("https://postlet.example.com/api/v1/messages/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${scopedKey.plaintextSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fromAddressId: ownerAddr.id,
          to: ["victim@external.org"],
          subject: "Spoof attempt",
          textBody: "Hi",
          attachmentIds: [staged.id],
        }),
      }),
      testEnv,
    );
    expect(sendRes.status).toBe(200);
    const sendJson = (await sendRes.json()) as {
      message: { fromAddress: string; attachments: unknown[] };
    };
    expect(sendJson.message.fromAddress).toBe("support@mail.example.com");
    expect(sendJson.message.attachments).toHaveLength(0);

    // 2. Supplying cross-alias threadId must be denied (403)
    const crossThreadRes = await app.fetch(
      new Request("https://postlet.example.com/api/v1/drafts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${scopedKey.plaintextSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: ["vip@partner.org"],
          subject: "Inject",
          textBody: "Cross thread",
          threadId: priv.threadId,
        }),
      }),
      testEnv,
    );
    expect(crossThreadRes.status).toBe(403);

    // 3. Supplying cross-alias replyToMessageId must be denied (403)
    const crossMsgRes = await app.fetch(
      new Request("https://postlet.example.com/api/v1/drafts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${scopedKey.plaintextSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: ["vip@partner.org"],
          subject: "Inject msg",
          textBody: "Cross msg",
          replyToMessageId: priv.messageId,
        }),
      }),
      testEnv,
    );
    expect(crossMsgRes.status).toBe(403);

    // 4. Even an unscoped key cannot read owner's pending-upload:* staged attachments
    const stagedFetch = await app.fetch(
      new Request(`https://postlet.example.com/api/v1/attachments/${staged.id}`, {
        headers: { Authorization: `Bearer ${unscopedKey.plaintextSecret}` },
      }),
      testEnv,
    );
    expect(stagedFetch.status).toBe(404);
  });

  it("forces SVG attachments to Content-Disposition: attachment with strict sandbox CSP while allowing safe raster PNG inline", async () => {
    const svgRecord = await storeAttachment(env.DB, env.ATTACHMENTS, {
      messageId: null,
      filename: "xss.svg",
      contentType: "image/svg+xml",
      sizeBytes: 36,
      body: new TextEncoder().encode("<svg onload=alert(1)></svg>"),
    });
    const pngRecord = await storeAttachment(env.DB, env.ATTACHMENTS, {
      messageId: null,
      filename: "photo.png",
      contentType: "image/png",
      sizeBytes: 4,
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });

    const testEnv = buildTestEnv();
    const app = createApp();

    const svgRes = await app.fetch(
      new Request(`http://localhost/api/admin/attachments/${svgRecord.id}?inline=true`),
      testEnv,
    );
    expect(svgRes.status).toBe(200);
    expect(svgRes.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(svgRes.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");

    const pngRes = await app.fetch(
      new Request(`http://localhost/api/admin/attachments/${pngRecord.id}?inline=true`),
      testEnv,
    );
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(pngRes.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
  });

  it("blocks alias-scoped agent keys from global Daily Inbox Summaries on both REST and MCP", async () => {
    const supportAddr = await createAddress(env.DB, { email: "support@mail.example.com" });
    await updateSettings(env.DB, { aiEnabled: true, aiDailySummaryEnabled: true });

    const scopedKey = await createAgentKey(
      env.DB,
      {
        name: "ScopedReader",
        scope: "read_only",
        allowedAddressId: supportAddr.id,
      },
      "https://postlet.example.com",
    );

    const mockAi = createMockWorkersAi();
    const testEnv = buildTestEnv({ AI: mockAi as unknown as Ai });
    const app = createApp();

    const getRes = await app.fetch(
      new Request("https://postlet.example.com/api/v1/ai/daily-summary", {
        headers: { Authorization: `Bearer ${scopedKey.plaintextSecret}` },
      }),
      testEnv,
    );
    expect(getRes.status).toBe(403);

    const postRes = await app.fetch(
      new Request("https://postlet.example.com/api/v1/ai/daily-summary", {
        method: "POST",
        headers: { Authorization: `Bearer ${scopedKey.plaintextSecret}` },
      }),
      testEnv,
    );
    expect(postRes.status).toBe(403);

    const mcpListRes = await app.fetch(
      new Request("https://postlet.example.com/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${scopedKey.plaintextSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      testEnv,
    );
    const toolNames = (
      (await mcpListRes.json()) as { result: { tools: Array<{ name: string }> } }
    ).result.tools.map((t) => t.name);
    expect(toolNames).not.toContain("get_daily_summary");
    expect(toolNames).not.toContain("generate_daily_summary");
  });

  it("enforces agent recipient domain allowlist, ignores external Reply-To redirection, and strips URLs in auto_send auto-reply", async () => {
    await createAddress(env.DB, { email: "me@mail.example.com", isDefault: true });
    await updateSettings(env.DB, {
      aiEnabled: true,
      aiImportantAutoReplyEnabled: true,
      aiImportantAutoReplyMode: "auto_send",
    });

    const mockAi = createMockWorkersAi((_m, input) => {
      const sys = ((input.messages as Array<{ role: string; content: string }>)[0]?.content ?? "");
      if (sys.includes("You classify emails")) {
        return {
          response: JSON.stringify({
            category: "action_required",
            priority: "high",
            summary: "Urgent message",
          }),
        };
      }
      return { response: "Confirmed! Visit https://evil-phish.example/login for details." };
    });

    const sentPayloads: Array<Record<string, unknown>> = [];
    const mockResend = createMockResendFetch({
      receivedEmails: {
        em_redirect: {
          id: "em_redirect",
          from: "sender@outside.org",
          to: ["me@mail.example.com"],
          subject: "Urgent check",
          text: "Please click https://evil-phish.example/login",
          headers: { "reply-to": "victim@thirdparty.com" },
        },
      },
      onSend: (p) => sentPayloads.push(p),
    });

    const testEnv = buildTestEnv({ AI: mockAi as unknown as Ai });
    const app = createApp({ resendFetchFn: mockResend.fetchFn });
    const resendClient = new ResendClient("re_test", mockResend.fetchFn);

    const ingested = await ingestInboundEmail(env.DB, env.ATTACHMENTS, resendClient, {
      email_id: "em_redirect",
      from: "sender@outside.org",
      to: ["me@mail.example.com"],
    });

    // Agent restricted to allowed.com must be denied from triggering auto-reply to outside.org
    const restrictedKey = await createAgentKey(
      env.DB,
      {
        name: "DomainRestricted",
        scope: "read_write",
        allowedRecipientDomains: ["allowed.com"],
      },
      "https://postlet.example.com",
    );

    const blockedRes = await app.fetch(
      new Request(`https://postlet.example.com/api/v1/ai/threads/${ingested.threadId}/auto-reply`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${restrictedKey.plaintextSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ force: true }),
      }),
      testEnv,
    );
    expect(blockedRes.status).toBe(403);
    expect(sentPayloads).toHaveLength(0);

    // Owner run sends strictly to fromAddress (outside.org, NOT thirdparty.com) and strips URL
    const ownerRes = await app.fetch(
      new Request(`http://localhost/api/admin/ai/threads/${ingested.threadId}/auto-reply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Postlet-CSRF": "1",
        },
        body: JSON.stringify({ force: true }),
      }),
      testEnv,
    );
    expect(ownerRes.status).toBe(200);
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0].to).toEqual(["sender@outside.org"]);
    expect(String(sentPayloads[0].text)).not.toContain("https://evil-phish.example");
    expect(String(sentPayloads[0].text)).toContain("[link removed]");
  });

  it("blocks CSRF attacks on /api/admin/* mutations and enforces uniform rate limits + email validation", async () => {
    const testEnv = buildTestEnv();
    const app = createApp();

    // Missing X-Postlet-CSRF header -> 403
    const noCsrf = await app.fetch(
      new Request("http://localhost/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aiEnabled: true }),
      }),
      testEnv,
    );
    expect(noCsrf.status).toBe(403);

    // Cross-site Sec-Fetch-Site -> 403 even with X-Postlet-CSRF
    const crossSite = await app.fetch(
      new Request("http://localhost/api/admin/settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Postlet-CSRF": "1",
          "Sec-Fetch-Site": "cross-site",
        },
        body: JSON.stringify({ aiEnabled: true }),
      }),
      testEnv,
    );
    expect(crossSite.status).toBe(403);

    // Origin mismatch -> 403
    const badOrigin = await app.fetch(
      new Request("http://localhost/api/admin/settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Postlet-CSRF": "1",
          Origin: "https://attacker.evil",
        },
        body: JSON.stringify({ aiEnabled: true }),
      }),
      testEnv,
    );
    expect(badOrigin.status).toBe(403);

    // Unallowlisted AI model rejected (400)
    const badModel = await app.fetch(
      new Request("http://localhost/api/admin/settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Postlet-CSRF": "1",
        },
        body: JSON.stringify({ aiModel: "@cf/arbitrary/unapproved" }),
      }),
      testEnv,
    );
    expect(badModel.status).toBe(400);

    // Rate limit counts MCP ping / GET addresses + malformed multi-@ email rejected
    const limitedKey = await createAgentKey(
      env.DB,
      {
        name: "MeteredAgent",
        scope: "read_write",
        allowedRecipientDomains: ["allowed.com"],
        rateLimitPerHour: 2,
      },
      "https://postlet.example.com",
    );

    const multiAtRes = await app.fetch(
      new Request("https://postlet.example.com/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${limitedKey.plaintextSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "send_email",
            arguments: {
              to: ["spoof@allowed.com@evil.com"],
              subject: "Spoof",
              textBody: "Test",
            },
          },
        }),
      }),
      testEnv,
    );
    const multiAtJson = (await multiAtRes.json()) as { result: { isError?: boolean } };
    expect(multiAtJson.result.isError).toBe(true);

    // Call 2: GET /api/v1/addresses (now audited and metered!)
    const addrRes = await app.fetch(
      new Request("https://postlet.example.com/api/v1/addresses", {
        headers: { Authorization: `Bearer ${limitedKey.plaintextSecret}` },
      }),
      testEnv,
    );
    expect(addrRes.status).toBe(200);

    // Call 3: Exceeds rateLimitPerHour (2) -> 429
    const overLimit = await app.fetch(
      new Request("https://postlet.example.com/api/v1/addresses", {
        headers: { Authorization: `Bearer ${limitedKey.plaintextSecret}` },
      }),
      testEnv,
    );
    expect(overLimit.status).toBe(429);
  });

  it("prevents cross-sender thread merging, validates inbound download URLs/sizes, enforces atomic AI quota, and sets security headers", async () => {
    await createAddress(env.DB, { email: "me@mail.example.com", isDefault: true });

    const mockResend = createMockResendFetch({
      receivedEmails: {
        em_alice: {
          id: "em_alice",
          from: "alice@company.com",
          to: ["me@mail.example.com"],
          subject: "Invoice",
          text: "Alice invoice",
        },
        em_stranger: {
          id: "em_stranger",
          from: "stranger@other.com",
          to: ["me@mail.example.com"],
          subject: "Invoice",
          text: "Stranger invoice",
        },
        em_http_att: {
          id: "em_http_att",
          from: "attacker@other.com",
          to: ["me@mail.example.com"],
          subject: "Bad URL",
          text: "Attachment",
          attachments: [
            { id: "bad_att", filename: "bad\r\n.txt", content_type: "text/plain" },
          ],
        },
      },
    });

    const resendClient = new ResendClient("re_test", mockResend.fetchFn);
    const rAlice = await ingestInboundEmail(env.DB, env.ATTACHMENTS, resendClient, {
      email_id: "em_alice",
      from: "alice@company.com",
      to: ["me@mail.example.com"],
    });
    const rStranger = await ingestInboundEmail(env.DB, env.ATTACHMENTS, resendClient, {
      email_id: "em_stranger",
      from: "stranger@other.com",
      to: ["me@mail.example.com"],
    });

    // Different external senders with identical subject "Invoice" must NOT merge threads
    expect(rAlice.threadId).not.toBe(rStranger.threadId);

    // Unsafe HTTP/internal download URL must be rejected
    await expect(
      resendClient.fetchDownloadStream("http://127.0.0.1/secret"),
    ).rejects.toThrow(/HTTPS/i);
    await expect(
      resendClient.fetchDownloadStream("https://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/disallowed internal host/i);

    // Atomic AI daily quota enforcement under concurrent Promise.all
    await updateSettings(env.DB, { aiEnabled: true, aiDailyCap: 1 });
    const mockAi = createMockWorkersAi(() => ({ response: "Summary" }));
    const testEnv = buildTestEnv({ AI: mockAi as unknown as Ai });

    const outcomes = await Promise.allSettled([
      summarizeThread(env.DB, testEnv, rAlice.threadId!, { force: true }),
      summarizeThread(env.DB, testEnv, rStranger.threadId!, { force: true }),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AiQuotaExceededError);

    // Global security headers present
    const app = createApp();
    const healthRes = await app.fetch(new Request("https://postlet.example.com/api/health"), testEnv);
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(healthRes.headers.get("X-Frame-Options")).toBe("DENY");
    expect(healthRes.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});
