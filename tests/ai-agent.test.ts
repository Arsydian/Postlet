/**
 * @file tests/ai-agent.test.ts
 * @description Tests Postlet's default-disabled Cloudflare Workers AI agent (`postlet-ai`),
 * daily free-tier call cap, thread summary caching, Built-In Function 1 (Daily Inbox Summary
 * with To-Dos & Reminders + Cron scheduling), and Built-In Function 2 (Important Email Auto-Reply
 * with RFC 3834 loop protection, cooldowns, and Queue-for-Approval vs. Auto-Send modes).
 */

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/worker/index";
import { createAddress, getSettings, updateSettings } from "../src/worker/services/addresses";
import { AiDisabledError, AiQuotaExceededError, summarizeThread } from "../src/worker/services/ai";
import {
  evaluateAndRunImportantAutoReply,
  generateDailyInboxSummary,
  runScheduledDailySummaryCheck,
  toggleDigestTodo,
} from "../src/worker/services/ai-functions";
import { getThreadDetail, ingestInboundEmail } from "../src/worker/services/mail";
import { ResendClient } from "../src/worker/services/resend";
import {
  buildTestEnv,
  createMockResendFetch,
  createMockWorkersAi,
  createSignedWebhookHeaders,
  resetDatabaseAndStorage,
} from "./helpers/test-env";

describe("Built-in Cloudflare Workers AI Agent & Functions", () => {
  beforeEach(async () => {
    await resetDatabaseAndStorage();
  });

  it("is disabled initially by default and makes zero env.AI calls until enabled in Settings", async () => {
    const settings = await getSettings(env.DB);
    expect(settings.aiEnabled).toBe(false);
    expect(settings.aiAutoTriageEnabled).toBe(false);
    expect(settings.aiDailySummaryEnabled).toBe(false);
    expect(settings.aiImportantAutoReplyEnabled).toBe(false);

    const mockAi = createMockWorkersAi();
    const mockResend = createMockResendFetch({
      receivedEmails: {
        em_init: {
          id: "em_init",
          from: "vip@client.com",
          to: ["owner@mail.example.com"],
          subject: "Urgent contract",
          text: "Please review today.",
        },
      },
    });
    const testEnv = buildTestEnv({ AI: mockAi as unknown as Ai });
    const app = createApp({ resendFetchFn: mockResend.fetchFn });

    const webhookBody = JSON.stringify({
      type: "email.received",
      data: { email_id: "em_init", from: "vip@client.com", to: ["owner@mail.example.com"] },
    });
    const res = await app.fetch(
      new Request("http://localhost/api/webhooks/resend", {
        method: "POST",
        headers: await createSignedWebhookHeaders(webhookBody, testEnv.RESEND_WEBHOOK_SECRET!),
        body: webhookBody,
      }),
      testEnv,
    );
    expect(res.status).toBe(200);
    const { threadId } = (await res.json()) as { threadId: string };

    // Webhook ingestion must NOT invoke AI when disabled
    expect(mockAi.run).not.toHaveBeenCalled();

    // Direct summary / digest calls reject cleanly with AiDisabledError
    await expect(summarizeThread(env.DB, testEnv, threadId)).rejects.toBeInstanceOf(
      AiDisabledError,
    );
    await expect(
      generateDailyInboxSummary(
        env.DB,
        testEnv,
        new ResendClient("re_test", mockResend.fetchFn),
        { triggeredBy: "owner" },
      ),
    ).rejects.toBeInstanceOf(AiDisabledError);
    expect(mockAi.run).not.toHaveBeenCalled();
  });

  it("caches thread summaries in D1 and enforces the daily free-tier call cap", async () => {
    await updateSettings(env.DB, { aiEnabled: true, aiDailyCap: 2 });

    const mockAi = createMockWorkersAi(() => ({
      response: "- Client requested Q4 review\n- Action: Send deck by Friday",
    }));
    const mockResend = createMockResendFetch({
      receivedEmails: {
        em_cap: {
          id: "em_cap",
          from: "pm@company.com",
          to: ["me@mail.example.com"],
          subject: "Q4 Deck",
          text: "Need Q4 deck by Friday.",
        },
      },
    });
    const testEnv = buildTestEnv({ AI: mockAi as unknown as Ai });
    const resendClient = new ResendClient("re_test", mockResend.fetchFn);
    const { threadId } = await ingestInboundEmail(env.DB, env.ATTACHMENTS, resendClient, {
      email_id: "em_cap",
      from: "pm@company.com",
      to: ["me@mail.example.com"],
    });

    // Call 1 -> invokes AI
    const s1 = await summarizeThread(env.DB, testEnv, threadId!);
    expect(s1.cached).toBe(false);
    expect(mockAi.run).toHaveBeenCalledTimes(1);

    // Call 2 (non-forced) -> served from D1 cache, 0 extra AI calls
    const s2 = await summarizeThread(env.DB, testEnv, threadId!);
    expect(s2.cached).toBe(true);
    expect(mockAi.run).toHaveBeenCalledTimes(1);

    // Call 3 (forced) -> invokes AI (count reaches 2 == cap)
    await summarizeThread(env.DB, testEnv, threadId!, { force: true });
    expect(mockAi.run).toHaveBeenCalledTimes(2);

    // Call 4 (forced) -> blocked by daily free-tier cap
    await expect(summarizeThread(env.DB, testEnv, threadId!, { force: true })).rejects.toBeInstanceOf(
      AiQuotaExceededError,
    );
  });

  it("generates Daily Inbox Summary with To-Dos & Reminders, toggles To-Dos, and honors Cron hour/timezone", async () => {
    await createAddress(env.DB, { email: "me@mail.example.com", isDefault: true });
    await updateSettings(env.DB, {
      aiEnabled: true,
      aiDailySummaryEnabled: true,
      aiDailySummaryHour: 9,
      aiDailySummaryTimezone: "UTC",
      aiDailySummaryEmailCopy: true,
    });

    const mockAi = createMockWorkersAi(() => ({
      response: JSON.stringify({
        overview: "You have 1 contract awaiting signature and 1 domain renewal reminder.",
        todos: [
          {
            title: "Sign vendor MSA and reply",
            sender: "legal@vendor.com",
            due_hint: "Tomorrow 5pm",
          },
        ],
        reminders: [{ title: "Domain renewal due", when: "Nov 25" }],
        fyi: [{ title: "Weekly status update received" }],
      }),
    }));

    const mockResend = createMockResendFetch({
      receivedEmails: {
        em_digest_1: {
          id: "em_digest_1",
          from: "legal@vendor.com",
          to: ["me@mail.example.com"],
          subject: "Vendor MSA",
          text: "Please sign the MSA by tomorrow 5pm.",
        },
      },
    });

    const testEnv = buildTestEnv({ AI: mockAi as unknown as Ai });
    const resendClient = new ResendClient("re_test", mockResend.fetchFn);
    await ingestInboundEmail(env.DB, env.ATTACHMENTS, resendClient, {
      email_id: "em_digest_1",
      from: "legal@vendor.com",
      to: ["me@mail.example.com"],
    });

    // Hour mismatch (07:00 UTC != 09:00 UTC) -> skipped
    const skipRes = await runScheduledDailySummaryCheck(
      env.DB,
      testEnv,
      resendClient,
      new Date("2026-11-20T07:00:00.000Z"),
    );
    expect(skipRes.ran).toBe(false);

    // Matching hour (09:00 UTC) -> generates digest & emails copy
    const runRes = await runScheduledDailySummaryCheck(
      env.DB,
      testEnv,
      resendClient,
      new Date("2026-11-20T09:00:00.000Z"),
    );
    expect(runRes.ran).toBe(true);
    expect(mockResend.calls.some((c) => c.url === "https://api.resend.com/emails")).toBe(true);

    // Same day re-check -> skipped because already ran today
    const secondCheck = await runScheduledDailySummaryCheck(
      env.DB,
      testEnv,
      resendClient,
      new Date("2026-11-20T09:30:00.000Z"),
    );
    expect(secondCheck.ran).toBe(false);

    // Toggle To-Do item done via service
    const app = createApp({ resendFetchFn: mockResend.fetchFn });
    const digestsRes = await app.fetch(new Request("http://localhost/api/admin/digests"), testEnv);
    const digestsJson = (await digestsRes.json()) as {
      digests: Array<{
        id: string;
        todos: Array<{ id: string; done: boolean; title: string }>;
        reminders: Array<{ title: string; when: string }>;
      }>;
    };
    expect(digestsJson.digests).toHaveLength(1);
    const digest = digestsJson.digests[0];
    expect(digest.todos[0].title).toBe("Sign vendor MSA and reply");
    expect(digest.reminders[0].when).toBe("Nov 25");

    const toggled = await toggleDigestTodo(env.DB, digest.id, digest.todos[0].id, true);
    expect(toggled?.todos[0].done).toBe(true);
  });

  it("enforces RFC 3834 loop protection and supports both Approval and Auto-Send modes for Important Email Auto-Reply", async () => {
    await createAddress(env.DB, { email: "me@mail.example.com", isDefault: true });
    await updateSettings(env.DB, {
      aiEnabled: true,
      aiImportantAutoReplyEnabled: true,
      aiImportantAutoReplyMode: "approval",
    });

    const mockAi = createMockWorkersAi((_model, input) => {
      const msgs = input.messages as Array<{ role: string; content: string }>;
      const sys = msgs[0]?.content ?? "";
      if (sys.includes("You classify emails")) {
        return {
          response: JSON.stringify({
            category: "action_required",
            priority: "high",
            summary: "Urgent client deadline request.",
          }),
        };
      }
      return { response: "Thanks for reaching out — I received your urgent note and will follow up shortly." };
    });

    const sentEmails: Array<Record<string, unknown>> = [];
    const mockResend = createMockResendFetch({
      receivedEmails: {
        em_noreply: {
          id: "em_noreply",
          from: "noreply@saas.com",
          to: ["me@mail.example.com"],
          subject: "Alert",
          text: "Automated alert",
        },
        em_autohdr: {
          id: "em_autohdr",
          from: "human@saas.com",
          to: ["me@mail.example.com"],
          subject: "Newsletter",
          text: "Weekly digest",
          headers: { "list-unsubscribe": "<mailto:unsub@saas.com>" },
        },
        em_important_1: {
          id: "em_important_1",
          from: "ceo@client.com",
          to: ["me@mail.example.com"],
          subject: "Urgent launch question",
          text: "Can we push the release to 3pm?",
        },
        em_important_2: {
          id: "em_important_2",
          from: "cto@partner.com",
          to: ["me@mail.example.com"],
          subject: "Production outage check",
          text: "Need immediate sign-off.",
        },
      },
      onSend: (p) => sentEmails.push(p),
    });

    const testEnv = buildTestEnv({ AI: mockAi as unknown as Ai });
    const resendClient = new ResendClient("re_test", mockResend.fetchFn);

    // 1. noreply@ blocked by RFC loop guard
    const rNoreply = await ingestInboundEmail(env.DB, env.ATTACHMENTS, resendClient, {
      email_id: "em_noreply",
      from: "noreply@saas.com",
      to: ["me@mail.example.com"],
    });
    const auto1 = await evaluateAndRunImportantAutoReply(
      env.DB,
      env.ATTACHMENTS,
      testEnv,
      resendClient,
      rNoreply.threadId!,
      { callerType: "webhook" },
    );
    expect(auto1.action).toBe("skipped");
    expect(auto1.reason).toContain("automated");

    // 2. List-Unsubscribe blocked by RFC loop guard
    const rList = await ingestInboundEmail(env.DB, env.ATTACHMENTS, resendClient, {
      email_id: "em_autohdr",
      from: "human@saas.com",
      to: ["me@mail.example.com"],
    });
    const auto2 = await evaluateAndRunImportantAutoReply(
      env.DB,
      env.ATTACHMENTS,
      testEnv,
      resendClient,
      rList.threadId!,
      { callerType: "webhook" },
    );
    expect(auto2.action).toBe("skipped");
    expect(auto2.reason).toContain("Mailing list");

    // 3. Important human email in "approval" mode -> queued as pending_approval, NOT sent
    const rImp1 = await ingestInboundEmail(env.DB, env.ATTACHMENTS, resendClient, {
      email_id: "em_important_1",
      from: "ceo@client.com",
      to: ["me@mail.example.com"],
    });
    const auto3 = await evaluateAndRunImportantAutoReply(
      env.DB,
      env.ATTACHMENTS,
      testEnv,
      resendClient,
      rImp1.threadId!,
      { callerType: "webhook" },
    );
    expect(auto3.executed).toBe(true);
    expect(auto3.action).toBe("queued_for_approval");
    expect(sentEmails).toHaveLength(0);

    const t1Detail = await getThreadDetail(env.DB, rImp1.threadId!);
    expect(t1Detail?.messages.some((m) => m.status === "pending_approval")).toBe(true);

    // 4. Cooldown blocks second auto-reply on same thread
    const auto3Repeat = await evaluateAndRunImportantAutoReply(
      env.DB,
      env.ATTACHMENTS,
      testEnv,
      resendClient,
      rImp1.threadId!,
      { callerType: "webhook" },
    );
    expect(auto3Repeat.action).toBe("skipped");
    expect(auto3Repeat.reason).toBe("thread_cooldown_active");

    // 5. Switch to "auto_send" -> sends immediately with Auto-Submitted: auto-replied header
    await updateSettings(env.DB, { aiImportantAutoReplyMode: "auto_send" });
    const rImp2 = await ingestInboundEmail(env.DB, env.ATTACHMENTS, resendClient, {
      email_id: "em_important_2",
      from: "cto@partner.com",
      to: ["me@mail.example.com"],
    });
    const auto4 = await evaluateAndRunImportantAutoReply(
      env.DB,
      env.ATTACHMENTS,
      testEnv,
      resendClient,
      rImp2.threadId!,
      { callerType: "webhook" },
    );
    expect(auto4.executed).toBe(true);
    expect(auto4.action).toBe("sent");
    expect(sentEmails).toHaveLength(1);
    expect((sentEmails[0].headers as Record<string, string>)["Auto-Submitted"]).toBe(
      "auto-replied",
    );
  });
});
