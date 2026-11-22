/**
 * @file tests/mail-and-threading.test.ts
 * @description Tests RFC 5322 In-Reply-To / References conversation threading, FTS5 full-text
 * search, configured address defaults, and the Pending Approval approve/reject workflow.
 */

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/worker/index";
import { createAddress } from "../src/worker/services/addresses";
import {
  getThreadDetail,
  ingestInboundEmail,
  listThreads,
} from "../src/worker/services/mail";
import { ResendClient } from "../src/worker/services/resend";
import {
  buildTestEnv,
  createMockResendFetch,
  resetDatabaseAndStorage,
} from "./helpers/test-env";

describe("Mail Threading, Search & Approval Flows", () => {
  beforeEach(async () => {
    await resetDatabaseAndStorage();
  });

  it("threads replies by RFC In-Reply-To headers and indexes content in FTS5 search", async () => {
    await createAddress(env.DB, {
      email: "me@mail.example.com",
      displayName: "Owner",
      isDefault: true,
    });

    const sentPayloads: Array<Record<string, unknown>> = [];
    const mockResend = createMockResendFetch({
      receivedEmails: {
        em_1: {
          id: "em_1",
          from: "Bob <bob@partner.io>",
          to: ["me@mail.example.com"],
          subject: "Q4 Architecture Review",
          text: "Can we review the Cloudflare Worker design tomorrow?",
          message_id: "<bob-msg-1@partner.io>",
          headers: { "message-id": "<bob-msg-1@partner.io>" },
        },
        em_2: {
          id: "em_2",
          from: "Bob <bob@partner.io>",
          to: ["me@mail.example.com"],
          subject: "Re: Q4 Architecture Review",
          text: "Sounds great, see you at 10am.",
          message_id: "<bob-msg-2@partner.io>",
          headers: {
            "message-id": "<bob-msg-2@partner.io>",
            "in-reply-to": "<bob-msg-1@partner.io>",
          },
        },
      },
      onSend: (p) => sentPayloads.push(p),
    });

    const resendClient = new ResendClient("re_test", mockResend.fetchFn);
    const r1 = await ingestInboundEmail(env.DB, env.ATTACHMENTS, resendClient, {
      email_id: "em_1",
      from: "bob@partner.io",
      to: ["me@mail.example.com"],
    });
    const r2 = await ingestInboundEmail(env.DB, env.ATTACHMENTS, resendClient, {
      email_id: "em_2",
      from: "bob@partner.io",
      to: ["me@mail.example.com"],
    });

    expect(r1.threadId).toBe(r2.threadId);

    // Search via FTS5
    const searchHits = await listThreads(env.DB, { q: "Cloudflare" });
    expect(searchHits).toHaveLength(1);
    expect(searchHits[0].id).toBe(r1.threadId);

    // Owner replies inside the thread; verify RFC In-Reply-To and References headers sent to Resend
    const testEnv = buildTestEnv();
    const app = createApp({ resendFetchFn: mockResend.fetchFn });
    const detailBefore = await getThreadDetail(env.DB, r1.threadId!);
    const firstMsgId = detailBefore!.messages[0].id;

    const replyRes = await app.fetch(
      new Request("http://localhost/api/admin/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Postlet-CSRF": "1",
        },
        body: JSON.stringify({
          mode: "send",
          to: ["bob@partner.io"],
          subject: "Q4 Architecture Review",
          textBody: "Confirmed, 10am works!",
          replyToMessageId: firstMsgId,
        }),
      }),
      testEnv,
    );
    expect(replyRes.status).toBe(200);
    expect(sentPayloads).toHaveLength(1);
    const headersSent = sentPayloads[0].headers as Record<string, string>;
    expect(headersSent["In-Reply-To"]).toBe("<bob-msg-1@partner.io>");
    expect(headersSent["References"]).toContain("<bob-msg-1@partner.io>");
  });

  it("supports Pending Approval editing, approval send, and rejection", async () => {
    await createAddress(env.DB, { email: "desk@mail.example.com", isDefault: true });
    const mockResend = createMockResendFetch();
    const testEnv = buildTestEnv();
    const app = createApp({ resendFetchFn: mockResend.fetchFn });

    // Create two pending approval drafts
    const d1 = await app.fetch(
      new Request("http://localhost/api/admin/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Postlet-CSRF": "1",
        },
        body: JSON.stringify({
          mode: "pending_approval",
          to: ["alice@example.org"],
          subject: "Draft One",
          textBody: "Original draft text",
        }),
      }),
      testEnv,
    );
    const d1Json = (await d1.json()) as { message: { id: string } };

    const d2 = await app.fetch(
      new Request("http://localhost/api/admin/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Postlet-CSRF": "1",
        },
        body: JSON.stringify({
          mode: "pending_approval",
          to: ["bob@example.org"],
          subject: "Draft Two",
          textBody: "Reject me",
        }),
      }),
      testEnv,
    );
    const d2Json = (await d2.json()) as { message: { id: string } };

    // Approve first with edited body
    const approveRes = await app.fetch(
      new Request(`http://localhost/api/admin/messages/${d1Json.message.id}/approve`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Postlet-CSRF": "1",
        },
        body: JSON.stringify({ textBody: "Owner edited & approved text" }),
      }),
      testEnv,
    );
    expect(approveRes.status).toBe(200);
    const approved = (await approveRes.json()) as { message: { status: string; textBody: string } };
    expect(approved.message.status).toBe("sent");
    expect(approved.message.textBody).toBe("Owner edited & approved text");
    expect(mockResend.calls).toHaveLength(1);

    // Reject second
    const rejectRes = await app.fetch(
      new Request(`http://localhost/api/admin/messages/${d2Json.message.id}/reject`, {
        method: "POST",
        headers: {
          "X-Postlet-CSRF": "1",
        },
      }),
      testEnv,
    );
    expect(rejectRes.status).toBe(200);
    expect(mockResend.calls).toHaveLength(1);
  });

  it("invokes globalThis.fetch with globalThis receiver when ResendClient uses default fetch (no Illegal invocation)", async () => {
    // 1. Native workerd fetch check (checks receiver before URL parsing, never throws Illegal invocation).
    for (const customFetch of [undefined, globalThis.fetch]) {
      const client = new ResendClient("re_test", customFetch, "http://invalid host");
      let thrown: unknown;
      try {
        await client.sendEmail({
          from: "a@example.com",
          to: ["b@example.com"],
          subject: "Test",
          text: "Hi",
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).not.toMatch(/Illegal invocation/i);
    }

    // 2. Strict receiver identity check verifying `this === globalThis`.
    const originalFetch = globalThis.fetch;
    let receivedThis: unknown = null;
    try {
      globalThis.fetch = async function (this: unknown) {
        receivedThis = this;
        return Response.json({ id: "re_default_fetch_ok" });
      } as typeof fetch;

      const client = new ResendClient("re_test");
      const res = await client.sendEmail({
        from: "a@example.com",
        to: ["b@example.com"],
        subject: "Test",
        text: "Hi",
      });
      expect(res.id).toBe("re_default_fetch_ok");
      expect(receivedThis).toBe(globalThis);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
