/**
 * @file src/worker/routes/agent-v1.ts
 * @description Scoped REST API (`/api/v1/*`) and OpenAPI 3.1 schema (`/api/v1/openapi.json`)
 * backed by the exact same domain services, guardrails, and audit logger as `/mcp`.
 */

import { Hono } from "hono";
import {
  agentSendOrDraftSchema,
  aiAutoReplyInputSchema,
  folderSchema,
} from "../../shared/schemas";
import type { AiCategory, AiPriority } from "../../shared/types";
import type { PostletEnv, PostletVariables } from "../env";
import { agentAuthMiddleware, assertAgentScope } from "../middleware/agent-auth";
import { recordAuditLog } from "../middleware/audit";
import { getDefaultAddress, listAddresses } from "../services/addresses";
import { hasAllowedFunction, validateAgentSendGuardrails } from "../services/agent-keys";
import {
  AiDisabledError,
  AiQuotaExceededError,
  summarizeThread,
  triageThread,
} from "../services/ai";
import {
  evaluateAndRunImportantAutoReply,
  FunctionDisabledError,
  generateDailyInboxSummary,
  getLatestDailyDigest,
} from "../services/ai-functions";
import { getAttachmentResponse } from "../services/attachments";
import {
  assertAgentThreadAccess,
  getThreadDetail,
  listThreads,
  sendOrDraftEmail,
} from "../services/mail";
import { ResendClient } from "../services/resend";

export function createAgentV1Routes(resendFetchFn?: typeof fetch) {
  const router = new Hono<{ Bindings: PostletEnv; Variables: PostletVariables }>();

  // Public OpenAPI 3.1 discovery schema so AI agents and tooling can inspect endpoints easily.
  router.get("/openapi.json", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      openapi: "3.1.0",
      info: {
        title: "Postlet Agent Mail API",
        version: c.env.APP_VERSION || "0.1.4",
        description:
          "Scoped mail & built-in AI functions API for AI agents. Use read_only, read_draft, or read_write bearer tokens.",
      },
      servers: [{ url: `${origin}/api/v1` }],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
        },
      },
      security: [{ bearerAuth: [] }],
      paths: {
        "/threads": { get: { summary: "List threads (read_only+)" } },
        "/threads/{id}": { get: { summary: "Read thread and messages (read_only+)" } },
        "/search": { get: { summary: "Full-text search emails (read_only+)" } },
        "/addresses": { get: { summary: "List permitted sender aliases (read_only+)" } },
        "/attachments/{id}": { get: { summary: "Download attachment stream (read_only+)" } },
        "/drafts": { post: { summary: "Create pending-approval draft (read_draft+)" } },
        "/messages/send": { post: { summary: "Send email immediately (read_write)" } },
        "/ai/daily-summary": {
          get: { summary: "Fetch latest Daily Inbox Summary (read_only+)" },
          post: { summary: "Generate Daily Inbox Summary (read_only+, when AI & function enabled)" },
        },
        "/ai/threads/{id}/summary": { post: { summary: "Summarize thread (read_only+)" } },
        "/ai/threads/{id}/triage": { post: { summary: "Triage thread (read_only+)" } },
        "/ai/threads/{id}/auto-reply": {
          post: { summary: "Run Important Email Auto-Reply (read_draft+ for approval, read_write for auto_send)" },
        },
      },
    });
  });

  router.use("/*", agentAuthMiddleware);

  router.get("/threads", async (c) => {
    const key = c.get("agentKey")!;
    const folderRaw = c.req.query("folder");
    const parsedFolder = folderRaw ? folderSchema.safeParse(folderRaw) : null;
    if (parsedFolder && !parsedFolder.success) {
      return c.json({ error: "Invalid folder filter" }, 400);
    }

    const threads = await listThreads(c.env.DB, {
      folder: parsedFolder?.data,
      unreadOnly: c.req.query("unread") === "true",
      priority: c.req.query("priority") as AiPriority | undefined,
      category: c.req.query("category") as AiCategory | undefined,
      q: c.req.query("q"),
      limit: Number.parseInt(c.req.query("limit") ?? "30", 10) || 30,
      offset: Number.parseInt(c.req.query("offset") ?? "0", 10) || 0,
      scopedAddressEmail: key.allowedAddressEmail,
    });

    await recordAuditLog(c.env.DB, {
      actorType: "agent_key",
      agentKeyId: key.id,
      actorLabel: key.name,
      action: "api:list_threads",
      resourceType: "thread",
      status: "allowed",
      details: { count: threads.length },
    });

    return c.json({ threads });
  });

  router.get("/search", async (c) => {
    const key = c.get("agentKey")!;
    const q = c.req.query("q") ?? "";
    const threads = await listThreads(c.env.DB, {
      q,
      limit: Number.parseInt(c.req.query("limit") ?? "30", 10) || 30,
      scopedAddressEmail: key.allowedAddressEmail,
    });
    await recordAuditLog(c.env.DB, {
      actorType: "agent_key",
      agentKeyId: key.id,
      actorLabel: key.name,
      action: "api:search",
      resourceType: "thread",
      status: "allowed",
      details: { q, count: threads.length },
    });
    return c.json({ threads });
  });

  router.get("/threads/:id", async (c) => {
    const key = c.get("agentKey")!;
    const thread = await getThreadDetail(c.env.DB, c.req.param("id"), key.allowedAddressEmail);
    if (!thread) {
      return c.json({ error: "Thread not found" }, 404);
    }
    await recordAuditLog(c.env.DB, {
      actorType: "agent_key",
      agentKeyId: key.id,
      actorLabel: key.name,
      action: "api:read_thread",
      resourceType: "thread",
      resourceId: thread.id,
      status: "allowed",
    });
    return c.json({ thread });
  });

  router.get("/addresses", async (c) => {
    const key = c.get("agentKey")!;
    const all = await listAddresses(c.env.DB);
    const addresses = key.allowedAddressEmail
      ? all.filter((a) => a.email.toLowerCase() === key.allowedAddressEmail!.toLowerCase())
      : all.filter((a) => a.isActive);
    await recordAuditLog(c.env.DB, {
      actorType: "agent_key",
      agentKeyId: key.id,
      actorLabel: key.name,
      action: "api:list_addresses",
      resourceType: "address",
      status: "allowed",
    });
    return c.json({ addresses });
  });

  router.get("/attachments/:id", async (c) => {
    const key = c.get("agentKey")!;
    const attachmentId = c.req.param("id");

    // Never expose owner staged uploads (message_id IS NULL); enforce alias lock when present.
    const ownerRow = await c.env.DB.prepare(
      `SELECT a.message_id, t.recipient_address
       FROM attachments a
       LEFT JOIN messages m ON m.id = a.message_id
       LEFT JOIN threads t ON t.id = m.thread_id
       WHERE a.id = ?`,
    )
      .bind(attachmentId)
      .first<{ message_id: string | null; recipient_address: string | null }>();

    if (
      !ownerRow ||
      !ownerRow.message_id ||
      !ownerRow.recipient_address ||
      (key.allowedAddressEmail &&
        ownerRow.recipient_address.toLowerCase() !== key.allowedAddressEmail.toLowerCase())
    ) {
      await recordAuditLog(c.env.DB, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
        action: "api:download_attachment",
        resourceType: "attachment",
        resourceId: attachmentId,
        status: "denied",
      });
      return c.json({ error: "Attachment not found" }, 404);
    }

    const res = await getAttachmentResponse(c.env.DB, c.env.ATTACHMENTS, attachmentId, false);
    if (!res) {
      return c.json({ error: "Attachment not found" }, 404);
    }
    await recordAuditLog(c.env.DB, {
      actorType: "agent_key",
      agentKeyId: key.id,
      actorLabel: key.name,
      action: "api:download_attachment",
      resourceType: "attachment",
      resourceId: attachmentId,
      status: "allowed",
    });
    return res;
  });

  router.post("/drafts", async (c) => {
    const keyOrErr = await assertAgentScope(c, "read_draft", "api:create_draft");
    if (keyOrErr instanceof Response) return keyOrErr;
    const key = keyOrErr;

    const body = await c.req.json().catch(() => null);
    const parsed = agentSendOrDraftSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", issues: parsed.error.flatten() }, 400);
    }

    const fromEmail =
      key.allowedAddressEmail ||
      parsed.data.fromAddress ||
      (await getDefaultAddress(c.env.DB))?.email ||
      "";

    const guardrailError = validateAgentSendGuardrails(key, fromEmail, [
      ...parsed.data.to,
      ...parsed.data.cc,
      ...parsed.data.bcc,
    ]);
    if (guardrailError) {
      await recordAuditLog(c.env.DB, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
        action: "api:create_draft",
        resourceType: "message",
        status: "denied",
        details: { reason: guardrailError },
      });
      return c.json({ error: guardrailError }, 403);
    }

    try {
      await assertAgentThreadAccess(c.env.DB, key.allowedAddressEmail, parsed.data);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Thread access denied";
      await recordAuditLog(c.env.DB, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
        action: "api:create_draft",
        resourceType: "thread",
        status: "denied",
        details: { reason },
      });
      return c.json({ error: reason }, 403);
    }

    const resendClient = new ResendClient(c.env.RESEND_API_KEY ?? "", resendFetchFn);
    const created = await sendOrDraftEmail(
      c.env.DB,
      c.env.ATTACHMENTS,
      resendClient,
      {
        mode: "pending_approval",
        fromAddress: fromEmail,
        fromAddressId: undefined,
        attachmentIds: [],
        to: parsed.data.to,
        cc: parsed.data.cc,
        bcc: parsed.data.bcc,
        replyTo: parsed.data.replyTo,
        subject: parsed.data.subject,
        textBody: parsed.data.textBody,
        htmlBody: parsed.data.htmlBody,
        threadId: parsed.data.threadId,
        replyToMessageId: parsed.data.replyToMessageId,
        forwardMessageId: parsed.data.forwardMessageId,
      },
      { actorLabel: `agent:${key.name}`, agentKeyId: key.id },
    );

    await recordAuditLog(c.env.DB, {
      actorType: "agent_key",
      agentKeyId: key.id,
      actorLabel: key.name,
      action: "api:create_draft",
      resourceType: "message",
      resourceId: created.message.id,
      status: "allowed",
      details: { to: parsed.data.to },
    });

    return c.json(created, 201);
  });

  router.post("/messages/send", async (c) => {
    const keyOrErr = await assertAgentScope(c, "read_write", "api:send_email");
    if (keyOrErr instanceof Response) return keyOrErr;
    const key = keyOrErr;

    const body = await c.req.json().catch(() => null);
    const parsed = agentSendOrDraftSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", issues: parsed.error.flatten() }, 400);
    }

    const fromEmail =
      key.allowedAddressEmail ||
      parsed.data.fromAddress ||
      (await getDefaultAddress(c.env.DB))?.email ||
      "";

    const guardrailError = validateAgentSendGuardrails(key, fromEmail, [
      ...parsed.data.to,
      ...parsed.data.cc,
      ...parsed.data.bcc,
    ]);
    if (guardrailError) {
      await recordAuditLog(c.env.DB, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
        action: "api:send_email",
        resourceType: "message",
        status: "denied",
        details: { reason: guardrailError },
      });
      return c.json({ error: guardrailError }, 403);
    }

    try {
      await assertAgentThreadAccess(c.env.DB, key.allowedAddressEmail, parsed.data);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Thread access denied";
      await recordAuditLog(c.env.DB, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
        action: "api:send_email",
        resourceType: "thread",
        status: "denied",
        details: { reason },
      });
      return c.json({ error: reason }, 403);
    }

    const resendClient = new ResendClient(c.env.RESEND_API_KEY ?? "", resendFetchFn);
    const sent = await sendOrDraftEmail(
      c.env.DB,
      c.env.ATTACHMENTS,
      resendClient,
      {
        mode: "send",
        fromAddress: fromEmail,
        fromAddressId: undefined,
        attachmentIds: [],
        to: parsed.data.to,
        cc: parsed.data.cc,
        bcc: parsed.data.bcc,
        replyTo: parsed.data.replyTo,
        subject: parsed.data.subject,
        textBody: parsed.data.textBody,
        htmlBody: parsed.data.htmlBody,
        threadId: parsed.data.threadId,
        replyToMessageId: parsed.data.replyToMessageId,
        forwardMessageId: parsed.data.forwardMessageId,
      },
      { actorLabel: `agent:${key.name}`, agentKeyId: key.id },
    );

    await recordAuditLog(c.env.DB, {
      actorType: "agent_key",
      agentKeyId: key.id,
      actorLabel: key.name,
      action: "api:send_email",
      resourceType: "message",
      resourceId: sent.message.id,
      status: "allowed",
      details: { to: parsed.data.to, resendEmailId: sent.message.resendEmailId },
    });

    return c.json(sent, 200);
  });

  router.get("/ai/daily-summary", async (c) => {
    const key = c.get("agentKey")!;
    if (!hasAllowedFunction(key, "daily_summary")) {
      return c.json({ error: "Agent key lacks 'daily_summary' permission" }, 403);
    }
    if (key.allowedAddressEmail) {
      await recordAuditLog(c.env.DB, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
        action: "api:get_daily_summary",
        resourceType: "digest",
        status: "denied",
        details: { reason: "Alias-scoped keys cannot read global inbox digests" },
      });
      return c.json({ error: "Daily summary is not available for alias-scoped agent keys" }, 403);
    }
    const digest = await getLatestDailyDigest(c.env.DB);
    await recordAuditLog(c.env.DB, {
      actorType: "agent_key",
      agentKeyId: key.id,
      actorLabel: key.name,
      action: "api:get_daily_summary",
      resourceType: "digest",
      resourceId: digest?.id ?? null,
      status: "allowed",
    });
    return c.json({ digest });
  });

  router.post("/ai/daily-summary", async (c) => {
    const key = c.get("agentKey")!;
    if (!hasAllowedFunction(key, "daily_summary")) {
      return c.json({ error: "Agent key lacks 'daily_summary' permission" }, 403);
    }
    if (key.allowedAddressEmail) {
      await recordAuditLog(c.env.DB, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
        action: "api:generate_daily_summary",
        resourceType: "digest",
        status: "denied",
        details: { reason: "Alias-scoped keys cannot generate global inbox digests" },
      });
      return c.json({ error: "Daily summary is not available for alias-scoped agent keys" }, 403);
    }
    const resendClient = new ResendClient(c.env.RESEND_API_KEY ?? "", resendFetchFn);
    try {
      const digest = await generateDailyInboxSummary(c.env.DB, c.env, resendClient, {
        triggeredBy: `agent:${key.name}`,
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
      });
      return c.json({ digest });
    } catch (err) {
      return mapAiErrorToResponse(c, err);
    }
  });

  router.post("/ai/threads/:id/summary", async (c) => {
    const key = c.get("agentKey")!;
    if (!hasAllowedFunction(key, "triage")) {
      return c.json({ error: "Agent key lacks 'triage' permission" }, 403);
    }
    const thread = await getThreadDetail(c.env.DB, c.req.param("id"), key.allowedAddressEmail);
    if (!thread) return c.json({ error: "Thread not found" }, 404);
    try {
      const result = await summarizeThread(c.env.DB, c.env, thread.id, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
      });
      return c.json(result);
    } catch (err) {
      return mapAiErrorToResponse(c, err);
    }
  });

  router.post("/ai/threads/:id/triage", async (c) => {
    const key = c.get("agentKey")!;
    if (!hasAllowedFunction(key, "triage")) {
      return c.json({ error: "Agent key lacks 'triage' permission" }, 403);
    }
    const thread = await getThreadDetail(c.env.DB, c.req.param("id"), key.allowedAddressEmail);
    if (!thread) return c.json({ error: "Thread not found" }, 404);
    try {
      const result = await triageThread(c.env.DB, c.env, thread.id, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
      });
      return c.json(result);
    } catch (err) {
      return mapAiErrorToResponse(c, err);
    }
  });

  router.post("/ai/threads/:id/auto-reply", async (c) => {
    const keyOrErr = await assertAgentScope(c, "read_draft", "api:important_auto_reply");
    if (keyOrErr instanceof Response) return keyOrErr;
    const key = keyOrErr;

    if (!hasAllowedFunction(key, "important_auto_reply")) {
      return c.json({ error: "Agent key lacks 'important_auto_reply' permission" }, 403);
    }
    const thread = await getThreadDetail(c.env.DB, c.req.param("id"), key.allowedAddressEmail);
    if (!thread) return c.json({ error: "Thread not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const parsed = aiAutoReplyInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", issues: parsed.error.flatten() }, 400);
    }
    if (parsed.data.modeOverride === "auto_send" && key.scope !== "read_write") {
      return c.json({ error: "'auto_send' mode requires 'read_write' scope" }, 403);
    }

    const resendClient = new ResendClient(c.env.RESEND_API_KEY ?? "", resendFetchFn);
    try {
      const result = await evaluateAndRunImportantAutoReply(
        c.env.DB,
        c.env.ATTACHMENTS,
        c.env,
        resendClient,
        thread.id,
        {
          callerType: "agent",
          agentKey: key,
          agentScope: key.scope,
          agentKeyId: key.id,
          actorLabel: key.name,
          modeOverride: parsed.data.modeOverride,
          instructionsOverride: parsed.data.instructionsOverride,
          force: parsed.data.force,
        },
      );
      return c.json(result);
    } catch (err) {
      return mapAiErrorToResponse(c, err);
    }
  });

  return router;
}

function mapAiErrorToResponse(
  c: { json: (data: unknown, status?: number) => Response },
  err: unknown,
): Response {
  if (err instanceof AiDisabledError || err instanceof FunctionDisabledError) {
    return c.json({ error: err.message, code: err.code }, 403);
  }
  if (err instanceof AiQuotaExceededError) {
    return c.json({ error: err.message, code: err.code }, 429);
  }
  if (err instanceof Error && err.message.startsWith("Permission denied:")) {
    return c.json({ error: err.message }, 403);
  }
  console.error(
    JSON.stringify({
      message: "agent ai error",
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  return c.json({ error: "AI operation failed" }, 500);
}
