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

  it("supports editing, syncing attachments on, and sending a saved draft", async () => {
    await createAddress(env.DB, {
      email: "owner@mail.example.com",
      displayName: "Owner",
      isDefault: true,
    });

    const sentPayloads: Array<Record<string, unknown>> = [];
    const mockResend = createMockResendFetch({
      onSend: (payload) => sentPayloads.push(payload),
    });
    const app = createApp({ resendFetchFn: mockResend.fetchFn });
    const testEnv = buildTestEnv();

    // Upload two staged attachments in R2
    const form1 = new FormData();
    form1.append("file", new File(["old draft attachment"], "old.txt", { type: "text/plain" }));
    const up1Res = await app.fetch(
      new Request("http://localhost/api/admin/attachments", {
        method: "POST",
        headers: { "X-Postlet-CSRF": "1" },
        body: form1,
      }),
      testEnv,
    );
    expect(up1Res.status).toBe(201);
    const { attachment: att1 } = (await up1Res.json()) as {
      attachment: { id: string; r2Key: string; filename: string };
    };

    const form2 = new FormData();
    form2.append("file", new File(["new draft attachment"], "new.txt", { type: "text/plain" }));
    const up2Res = await app.fetch(
      new Request("http://localhost/api/admin/attachments", {
        method: "POST",
        headers: { "X-Postlet-CSRF": "1" },
        body: form2,
      }),
      testEnv,
    );
    expect(up2Res.status).toBe(201);
    const { attachment: att2 } = (await up2Res.json()) as {
      attachment: { id: string; r2Key: string; filename: string };
    };

    // 1. Save initial standalone draft with att1
    const createDraftRes = await app.fetch(
      new Request("http://localhost/api/admin/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Postlet-CSRF": "1",
        },
        body: JSON.stringify({
          mode: "draft",
          to: ["initial@example.org"],
          subject: "Initial Draft Subject",
          textBody: "Initial draft content",
          htmlBody: "<p>Initial draft content</p>",
          attachmentIds: [att1.id],
        }),
      }),
      testEnv,
    );
    expect(createDraftRes.status).toBe(201);
    const created = (await createDraftRes.json()) as {
      message: { id: string; status: string; attachments: Array<{ id: string }> };
      threadId: string;
    };
    expect(created.message.status).toBe("draft");
    expect(created.message.attachments.map((a) => a.id)).toEqual([att1.id]);

    // 2. Edit the draft in place: change recipients, subject, body, swap att1 -> att2
    const editRes = await app.fetch(
      new Request(`http://localhost/api/admin/messages/${created.message.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "X-Postlet-CSRF": "1",
        },
        body: JSON.stringify({
          mode: "draft",
          to: ["final@example.org"],
          cc: ["copied@example.org"],
          subject: "Updated Draft Subject",
          textBody: "Updated body containing searchable draftdelta99 token",
          htmlBody: "<p>Updated body containing searchable draftdelta99 token</p>",
          attachmentIds: [att2.id],
        }),
      }),
      testEnv,
    );
    expect(editRes.status).toBe(200);
    const edited = (await editRes.json()) as {
      message: {
        id: string;
        status: string;
        subject: string;
        toAddresses: string[];
        attachments: Array<{ id: string; filename: string }>;
      };
      threadId: string;
    };
    expect(edited.message.status).toBe("draft");
    expect(edited.message.subject).toBe("Updated Draft Subject");
    expect(edited.message.toAddresses).toEqual(["final@example.org"]);
    expect(edited.message.attachments.map((a) => a.id)).toEqual([att2.id]);
    expect(sentPayloads).toHaveLength(0);

    // Old R2 object was cleaned up; new R2 object remains
    expect(await env.ATTACHMENTS.head(att1.r2Key)).toBeNull();
    expect(await env.ATTACHMENTS.head(att2.r2Key)).not.toBeNull();

    // Thread metadata and FTS5 reflect the updated draft
    const threadDetail = await getThreadDetail(env.DB, created.threadId);
    expect(threadDetail?.subject).toBe("Updated Draft Subject");
    expect(threadDetail?.folder).toBe("drafts");
    const searchHits = await listThreads(env.DB, { q: "draftdelta99" });
    expect(searchHits.map((t) => t.id)).toEqual([created.threadId]);

    // 3. Send the saved draft via PATCH mode=send
    const sendRes = await app.fetch(
      new Request(`http://localhost/api/admin/messages/${created.message.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "X-Postlet-CSRF": "1",
        },
        body: JSON.stringify({
          mode: "send",
          to: ["final@example.org"],
          cc: ["copied@example.org"],
          subject: "Ready To Send Subject",
          textBody: "Final sent draft body",
          htmlBody: "<p>Final sent draft body</p>",
          attachmentIds: [att2.id],
        }),
      }),
      testEnv,
    );
    expect(sendRes.status).toBe(200);
    const sent = (await sendRes.json()) as {
      message: { status: string; resendEmailId: string | null };
    };
    expect(sent.message.status).toBe("sent");
    expect(sent.message.resendEmailId).toBe("re_sent_1");
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0].subject).toBe("Ready To Send Subject");
    expect(sentPayloads[0].to).toEqual(["final@example.org"]);
    expect((sentPayloads[0].attachments as Array<{ filename: string }>)[0]?.filename).toBe(
      "new.txt",
    );

    const sentThread = await getThreadDetail(env.DB, created.threadId);
    expect(sentThread?.folder).toBe("sent");

    const metaRes = await app.fetch(new Request("http://localhost/api/admin/meta"), testEnv);
    const meta = (await metaRes.json()) as { counts: { drafts: number; sent: number } };
    expect(meta.counts.drafts).toBe(0);
    expect(meta.counts.sent).toBe(1);

    // Editing or discarding a sent message must be rejected
    const editSentRes = await app.fetch(
      new Request(`http://localhost/api/admin/messages/${created.message.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "X-Postlet-CSRF": "1",
        },
        body: JSON.stringify({
          mode: "draft",
          to: ["final@example.org"],
          subject: "Should Fail",
          textBody: "Nope",
          htmlBody: "",
        }),
      }),
      testEnv,
    );
    expect(editSentRes.status).toBe(400);

    const deleteSentRes = await app.fetch(
      new Request(`http://localhost/api/admin/messages/${created.message.id}`, {
        method: "DELETE",
        headers: { "X-Postlet-CSRF": "1" },
      }),
      testEnv,
    );
    expect(deleteSentRes.status).toBe(400);
  });

  it("supports discarding standalone drafts and reply drafts inside existing threads", async () => {
    await createAddress(env.DB, {
      email: "owner@mail.example.com",
      displayName: "Owner",
      isDefault: true,
    });

    const mockResend = createMockResendFetch({
      receivedEmails: {
        em_parent_1: {
          id: "em_parent_1",
          from: "Alice <alice@example.org>",
          to: ["owner@mail.example.com"],
          subject: "Original Thread",
          text: "Original inbound snippet text",
          message_id: "<parent-1@example.org>",
          headers: { "message-id": "<parent-1@example.org>" },
        },
      },
    });
    const app = createApp({ resendFetchFn: mockResend.fetchFn });
    const testEnv = buildTestEnv();

    // Case A: Standalone draft with attachment -> deleting deletes attachment + empty thread
    const form = new FormData();
    form.append("file", new File(["temp file"], "temp.txt", { type: "text/plain" }));
    const uploadRes = await app.fetch(
      new Request("http://localhost/api/admin/attachments", {
        method: "POST",
        headers: { "X-Postlet-CSRF": "1" },
        body: form,
      }),
      testEnv,
    );
    const { attachment } = (await uploadRes.json()) as { attachment: { id: string; r2Key: string } };

    const standaloneRes = await app.fetch(
      new Request("http://localhost/api/admin/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Postlet-CSRF": "1",
        },
        body: JSON.stringify({
          mode: "draft",
          to: ["someone@example.org"],
          subject: "Discard Me",
          textBody: "Temporary draft",
          htmlBody: "",
          attachmentIds: [attachment.id],
        }),
      }),
      testEnv,
    );
    const standaloneJson = (await standaloneRes.json()) as {
      message: { id: string };
      threadId: string;
    };

    const delStandaloneRes = await app.fetch(
      new Request(`http://localhost/api/admin/messages/${standaloneJson.message.id}`, {
        method: "DELETE",
        headers: { "X-Postlet-CSRF": "1" },
      }),
      testEnv,
    );
    expect(delStandaloneRes.status).toBe(200);
    expect(await delStandaloneRes.json()).toEqual({ ok: true, threadDeleted: true });
    expect(await env.ATTACHMENTS.head(attachment.r2Key)).toBeNull();
    expect(await getThreadDetail(env.DB, standaloneJson.threadId)).toBeNull();

    // Case B: Reply draft inside an existing inbound thread -> deleting preserves parent thread
    const resendClient = new ResendClient("re_test", mockResend.fetchFn);
    const inbound = await ingestInboundEmail(env.DB, env.ATTACHMENTS, resendClient, {
      email_id: "em_parent_1",
      from: "alice@example.org",
      to: ["owner@mail.example.com"],
    });

    const replyDraftRes = await app.fetch(
      new Request("http://localhost/api/admin/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Postlet-CSRF": "1",
        },
        body: JSON.stringify({
          mode: "draft",
          to: ["alice@example.org"],
          subject: "Re: Original Thread",
          textBody: "Unfinished reply draft",
          htmlBody: "",
          threadId: inbound.threadId,
          replyToMessageId: inbound.messageId,
        }),
      }),
      testEnv,
    );
    expect(replyDraftRes.status).toBe(201);
    const replyDraft = (await replyDraftRes.json()) as { message: { id: string } };

    const delReplyRes = await app.fetch(
      new Request(`http://localhost/api/admin/messages/${replyDraft.message.id}`, {
        method: "DELETE",
        headers: { "X-Postlet-CSRF": "1" },
      }),
      testEnv,
    );
    expect(delReplyRes.status).toBe(200);
    expect(await delReplyRes.json()).toEqual({ ok: true, threadDeleted: false });

    expect(inbound.threadId).toBeTruthy();
    const remainingThread = await getThreadDetail(env.DB, inbound.threadId!);
    expect(remainingThread).not.toBeNull();
    expect(remainingThread?.messageCount).toBe(1);
    expect(remainingThread?.messages).toHaveLength(1);
    expect(remainingThread?.snippet).toContain("Original inbound snippet text");
  });
});
