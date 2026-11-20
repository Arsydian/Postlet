/**
 * @file tests/webhooks.test.ts
 * @description Tests Resend Svix webhook signature verification, replay protection,
 * inbound email + R2 attachment ingestion, idempotency, catch-all handling, and
 * outbound delivery lifecycle status updates.
 */

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/worker/index";
import { createAddress, updateSettings } from "../src/worker/services/addresses";
import { listThreads, getThreadDetail } from "../src/worker/services/mail";
import {
  buildTestEnv,
  createMockResendFetch,
  createSignedWebhookHeaders,
  resetDatabaseAndStorage,
} from "./helpers/test-env";

describe("Resend Webhooks (Inbound & Delivery Status)", () => {
  beforeEach(async () => {
    await resetDatabaseAndStorage();
  });

  it("rejects missing, invalid, and expired Svix signatures", async () => {
    const testEnv = buildTestEnv();
    const app = createApp();
    const body = JSON.stringify({ type: "email.received", data: { email_id: "em_1" } });

    // Missing headers -> 401
    const resMissing = await app.fetch(
      new Request("http://localhost/api/webhooks/resend", { method: "POST", body }),
      testEnv,
    );
    expect(resMissing.status).toBe(401);

    // Tampered body -> 401
    const headers = await createSignedWebhookHeaders(body, testEnv.RESEND_WEBHOOK_SECRET!);
    const resTampered = await app.fetch(
      new Request("http://localhost/api/webhooks/resend", {
        method: "POST",
        headers,
        body: body.replace("em_1", "em_tampered"),
      }),
      testEnv,
    );
    expect(resTampered.status).toBe(401);

    // Stale timestamp (> 5 minutes old) -> 401
    const expiredHeaders = await createSignedWebhookHeaders(body, testEnv.RESEND_WEBHOOK_SECRET!, {
      timestamp: Math.floor(Date.now() / 1000) - 600,
    });
    const resExpired = await app.fetch(
      new Request("http://localhost/api/webhooks/resend", {
        method: "POST",
        headers: expiredHeaders,
        body,
      }),
      testEnv,
    );
    expect(resExpired.status).toBe(401);
  });

  it("ingests inbound email.received, fetches body & streams attachments into R2 idempotently", async () => {
    const receiptBytes = new TextEncoder().encode("PDF-MOCK-BYTES");
    const mockResend = createMockResendFetch({
      receivedEmails: {
        em_inbound_1: {
          id: "em_inbound_1",
          from: "Alice Sender <alice@external.org>",
          to: ["anything@mail.example.com"],
          subject: "Invoice #402",
          text: "Please find the attached receipt.",
          html: "<p>Please find the <strong>attached</strong> receipt.</p>",
          message_id: "<alice-402@external.org>",
          headers: { "message-id": "<alice-402@external.org>" },
          attachments: [
            {
              id: "att_1",
              filename: "invoice-402.pdf",
              content_type: "application/pdf",
            },
          ],
        },
      },
      attachmentFiles: {
        att_1: {
          filename: "invoice-402.pdf",
          contentType: "application/pdf",
          bytes: receiptBytes,
        },
      },
    });

    const testEnv = buildTestEnv();
    const app = createApp({ resendFetchFn: mockResend.fetchFn });

    const webhookPayload = JSON.stringify({
      type: "email.received",
      created_at: "2026-11-20T18:00:00.000Z",
      data: {
        email_id: "em_inbound_1",
        from: "Alice Sender <alice@external.org>",
        to: ["anything@mail.example.com"],
        subject: "Invoice #402",
        attachments: [{ id: "att_1", filename: "invoice-402.pdf", content_type: "application/pdf" }],
      },
    });

    const headers = await createSignedWebhookHeaders(webhookPayload, testEnv.RESEND_WEBHOOK_SECRET!);
    const res1 = await app.fetch(
      new Request("http://localhost/api/webhooks/resend", {
        method: "POST",
        headers,
        body: webhookPayload,
      }),
      testEnv,
    );
    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as { created: boolean; threadId: string };
    expect(json1.created).toBe(true);

    // Duplicate webhook delivery must be idempotent.
    const headers2 = await createSignedWebhookHeaders(webhookPayload, testEnv.RESEND_WEBHOOK_SECRET!);
    const res2 = await app.fetch(
      new Request("http://localhost/api/webhooks/resend", {
        method: "POST",
        headers: headers2,
        body: webhookPayload,
      }),
      testEnv,
    );
    expect(res2.status).toBe(200);
    const json2 = (await res2.json()) as { created: boolean };
    expect(json2.created).toBe(false);

    const threads = await listThreads(env.DB, { folder: "inbox" });
    expect(threads).toHaveLength(1);
    expect(threads[0].recipientAddress).toBe("anything@mail.example.com");

    const detail = await getThreadDetail(env.DB, json1.threadId);
    expect(detail?.messages).toHaveLength(1);
    expect(detail?.messages[0].htmlBody).toContain("<strong>attached</strong>");
    expect(detail?.messages[0].attachments).toHaveLength(1);

    // Verify attachment binary stored in R2 and downloadable via admin API with immutable cache.
    const attId = detail!.messages[0].attachments[0].id;
    const downloadRes = await app.fetch(
      new Request(`http://localhost/api/admin/attachments/${attId}`),
      testEnv,
    );
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("Cache-Control")).toContain("immutable");
    expect(await downloadRes.text()).toBe("PDF-MOCK-BYTES");
  });

  it("ignores unknown recipients when catch-all is disabled, and updates delivery/bounce status", async () => {
    await updateSettings(env.DB, { catchAllEnabled: false });
    await createAddress(env.DB, { email: "vip@mail.example.com", isDefault: true });

    const mockResend = createMockResendFetch({
      receivedEmails: {
        em_unknown: {
          id: "em_unknown",
          from: "spam@outside.com",
          to: ["random@mail.example.com"],
          subject: "Ignored",
          text: "Should be ignored",
        },
      },
    });
    const testEnv = buildTestEnv();
    const app = createApp({ resendFetchFn: mockResend.fetchFn });

    const ignoredPayload = JSON.stringify({
      type: "email.received",
      data: { email_id: "em_unknown", from: "spam@outside.com", to: ["random@mail.example.com"] },
    });
    const ignoredRes = await app.fetch(
      new Request("http://localhost/api/webhooks/resend", {
        method: "POST",
        headers: await createSignedWebhookHeaders(ignoredPayload, testEnv.RESEND_WEBHOOK_SECRET!),
        body: ignoredPayload,
      }),
      testEnv,
    );
    const ignoredJson = (await ignoredRes.json()) as { ignored: boolean };
    expect(ignoredJson.ignored).toBe(true);

    // Send outbound email, then deliver bounce webhook event.
    const sendRes = await app.fetch(
      new Request("http://localhost/api/admin/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Postlet-CSRF": "1",
        },
        body: JSON.stringify({
          mode: "send",
          to: ["bad@bounce.test"],
          subject: "Delivery Check",
          textBody: "Hello",
        }),
      }),
      testEnv,
    );
    expect(sendRes.status).toBe(200);
    const sentJson = (await sendRes.json()) as {
      message: { id: string; resendEmailId: string };
      threadId: string;
    };

    const bouncePayload = JSON.stringify({
      type: "email.bounced",
      created_at: "2026-11-20T18:05:00.000Z",
      data: {
        email_id: sentJson.message.resendEmailId,
        bounce: { message: "550 5.1.1 User unknown" },
      },
    });
    const bounceRes = await app.fetch(
      new Request("http://localhost/api/webhooks/resend", {
        method: "POST",
        headers: await createSignedWebhookHeaders(bouncePayload, testEnv.RESEND_WEBHOOK_SECRET!),
        body: bouncePayload,
      }),
      testEnv,
    );
    expect(bounceRes.status).toBe(200);

    const detail = await getThreadDetail(env.DB, sentJson.threadId);
    expect(detail?.messages[0].status).toBe("bounced");
    expect(detail?.messages[0].deliveryError).toContain("550 5.1.1 User unknown");
  });
});
