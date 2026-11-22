/**
 * @file src/worker/routes/admin.ts
 * @description Owner-only Web UI API routes (`/api/admin/*`) guarded by Cloudflare Zero Trust
 * Access JWT verification. Exposes inbox operations, attachments, configured addresses,
 * Cloudflare Workers AI settings & built-in functions, Daily Digests, Agent Keys, and Audit Logs.
 */

import { Hono } from "hono";
import {
  aiAutoReplyInputSchema,
  aiSuggestReplySchema,
  approveMessageSchema,
  createAddressSchema,
  createAgentKeySchema,
  folderSchema,
  sendOrDraftMessageSchema,
  toggleTodoSchema,
  updateAddressSchema,
  updateDraftMessageSchema,
  updateSettingsSchema,
  updateThreadSchema,
} from "../../shared/schemas";
import type { AiCategory, AiPriority } from "../../shared/types";
import type { PostletEnv, PostletVariables } from "../env";
import {
  createAccessAuthMiddleware,
  createAdminCsrfMiddleware,
} from "../middleware/access-auth";
import { listAuditLogs, recordAuditLog } from "../middleware/audit";
import {
  createAddress,
  deleteAddress,
  getSettings,
  listAddresses,
  updateAddress,
  updateSettings,
} from "../services/addresses";
import { createAgentKey, listAgentKeys, revokeAgentKey } from "../services/agent-keys";
import {
  AiDisabledError,
  AiQuotaExceededError,
  suggestReply,
  summarizeThread,
  triageThread,
} from "../services/ai";
import {
  evaluateAndRunImportantAutoReply,
  generateDailyInboxSummary,
  getLatestDailyDigest,
  listDailyDigests,
  toggleDigestTodo,
} from "../services/ai-functions";
import { getAttachmentResponse, storeAttachment } from "../services/attachments";
import {
  approvePendingMessage,
  deleteDraftMessage,
  deleteThreadPermanently,
  getFolderCounts,
  getThreadDetail,
  listThreads,
  rejectPendingMessage,
  sendOrDraftEmail,
  updateDraftMessage,
  updateThread,
} from "../services/mail";
import { ResendClient } from "../services/resend";

async function parseOptionalJsonBody(
  c: { req: { text: () => Promise<string> } },
): Promise<{ ok: true; data: unknown } | { ok: false }> {
  const raw = await c.req.text();
  if (!raw.trim()) {
    return { ok: true, data: {} };
  }
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

export function createAdminRoutes(options?: {
  accessFetchFn?: typeof fetch;
  resendFetchFn?: typeof fetch;
}) {
  const router = new Hono<{ Bindings: PostletEnv; Variables: PostletVariables }>();
  router.use("/*", createAccessAuthMiddleware(options?.accessFetchFn));
  router.use("/*", createAdminCsrfMiddleware());

  router.get("/meta", async (c) => {
    const [counts, settings, addresses, latestDigest] = await Promise.all([
      getFolderCounts(c.env.DB),
      getSettings(c.env.DB, c.env.MAIL_DOMAIN ?? "", c.env.DEFAULT_AI_MODEL),
      listAddresses(c.env.DB),
      getLatestDailyDigest(c.env.DB),
    ]);

    return c.json({
      appName: c.env.APP_NAME || "Postlet",
      appVersion: c.env.APP_VERSION || "0.2.0",
      ownerEmail: c.get("ownerEmail") ?? "owner",
      counts,
      settings,
      addresses,
      latestDigestDate: latestDigest?.digestDate ?? null,
    });
  });

  // ---------------------------------------------------------------------------
  // Threads & Messages
  // ---------------------------------------------------------------------------

  router.get("/threads", async (c) => {
    const folderRaw = c.req.query("folder");
    const parsedFolder = folderRaw ? folderSchema.safeParse(folderRaw) : null;
    if (parsedFolder && !parsedFolder.success) {
      return c.json({ error: "Invalid folder filter" }, 400);
    }

    const threads = await listThreads(c.env.DB, {
      folder: parsedFolder?.data,
      address: c.req.query("address") || undefined,
      unreadOnly: c.req.query("unread") === "true",
      priority: (c.req.query("priority") || undefined) as AiPriority | undefined,
      category: (c.req.query("category") || undefined) as AiCategory | undefined,
      q: c.req.query("q") || undefined,
      limit: Number.parseInt(c.req.query("limit") ?? "40", 10) || 40,
      offset: Number.parseInt(c.req.query("offset") ?? "0", 10) || 0,
    });

    return c.json({ threads });
  });

  router.get("/threads/:id", async (c) => {
    const threadId = c.req.param("id");
    const thread = await getThreadDetail(c.env.DB, threadId);
    if (!thread) {
      return c.json({ error: "Thread not found" }, 404);
    }
    return c.json({ thread });
  });

  router.patch("/threads/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = updateThreadSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", issues: parsed.error.flatten() }, 400);
    }

    const updated = await updateThread(c.env.DB, c.req.param("id"), parsed.data);
    if (!updated) {
      return c.json({ error: "Thread not found" }, 404);
    }
    return c.json({ thread: updated });
  });

  router.delete("/threads/:id", async (c) => {
    const deleted = await deleteThreadPermanently(c.env.DB, c.env.ATTACHMENTS, c.req.param("id"));
    if (!deleted) {
      return c.json({ error: "Thread not found" }, 404);
    }
    return c.json({ ok: true });
  });

  router.post("/messages", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = sendOrDraftMessageSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", issues: parsed.error.flatten() }, 400);
    }

    const resendClient = new ResendClient(c.env.RESEND_API_KEY ?? "", options?.resendFetchFn);
    try {
      const result = await sendOrDraftEmail(
        c.env.DB,
        c.env.ATTACHMENTS,
        resendClient,
        parsed.data,
        { actorLabel: c.get("ownerEmail") ?? "owner" },
      );
      return c.json(result, parsed.data.mode === "send" ? 200 : 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to process message";
      return c.json({ error: msg }, 400);
    }
  });

  router.post("/messages/:id/approve", async (c) => {
    const bodyRes = await parseOptionalJsonBody(c);
    if (!bodyRes.ok) {
      return c.json({ error: "Malformed JSON request body" }, 400);
    }
    const parsed = approveMessageSchema.safeParse(bodyRes.data);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", issues: parsed.error.flatten() }, 400);
    }

    const resendClient = new ResendClient(c.env.RESEND_API_KEY ?? "", options?.resendFetchFn);
    try {
      const message = await approvePendingMessage(
        c.env.DB,
        c.env.ATTACHMENTS,
        resendClient,
        c.req.param("id"),
        parsed.data,
      );
      await recordAuditLog(c.env.DB, {
        actorType: "owner",
        actorLabel: c.get("ownerEmail") ?? "owner",
        action: "owner:approve_message",
        resourceType: "message",
        resourceId: message.id,
        status: "allowed",
      });
      return c.json({ message });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to approve message";
      return c.json({ error: msg }, 400);
    }
  });

  router.post("/messages/:id/reject", async (c) => {
    const messageId = c.req.param("id");
    const ok = await rejectPendingMessage(c.env.DB, messageId);
    if (!ok) {
      return c.json({ error: "Pending message not found" }, 404);
    }
    await recordAuditLog(c.env.DB, {
      actorType: "owner",
      actorLabel: c.get("ownerEmail") ?? "owner",
      action: "owner:reject_message",
      resourceType: "message",
      resourceId: messageId,
      status: "allowed",
    });
    return c.json({ ok: true });
  });

  router.patch("/messages/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = updateDraftMessageSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", issues: parsed.error.flatten() }, 400);
    }

    const messageId = c.req.param("id");
    const resendClient = new ResendClient(c.env.RESEND_API_KEY ?? "", options?.resendFetchFn);
    try {
      const result = await updateDraftMessage(
        c.env.DB,
        c.env.ATTACHMENTS,
        resendClient,
        messageId,
        parsed.data,
      );
      await recordAuditLog(c.env.DB, {
        actorType: "owner",
        actorLabel: c.get("ownerEmail") ?? "owner",
        action: parsed.data.mode === "send" ? "owner:send_draft" : "owner:update_draft",
        resourceType: "message",
        resourceId: result.message.id,
        status: "allowed",
      });
      return c.json(result, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update draft";
      const status = msg.toLowerCase().includes("not found") ? 404 : 400;
      return c.json({ error: msg }, status);
    }
  });

  router.delete("/messages/:id", async (c) => {
    const messageId = c.req.param("id");
    try {
      const res = await deleteDraftMessage(c.env.DB, c.env.ATTACHMENTS, messageId);
      if (!res.deleted) {
        return c.json({ error: "Draft message not found" }, 404);
      }
      await recordAuditLog(c.env.DB, {
        actorType: "owner",
        actorLabel: c.get("ownerEmail") ?? "owner",
        action: "owner:discard_draft",
        resourceType: "message",
        resourceId: messageId,
        status: "allowed",
      });
      return c.json({ ok: true, threadDeleted: res.threadDeleted });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to discard draft";
      return c.json({ error: msg }, 400);
    }
  });

  // ---------------------------------------------------------------------------
  // Attachments (R2)
  // ---------------------------------------------------------------------------

  router.post("/attachments", async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (!form) {
      return c.json({ error: "Expected multipart/form-data upload" }, 400);
    }
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return c.json({ error: "Missing 'file' field" }, 400);
    }
    const fileObj = file as File;
    if (fileObj.size > 20 * 1024 * 1024) {
      return c.json({ error: "Single attachment exceeds 20 MB limit" }, 400);
    }

    const buf = await fileObj.arrayBuffer();
    const record = await storeAttachment(c.env.DB, c.env.ATTACHMENTS, {
      messageId: null,
      filename: fileObj.name || "attachment.bin",
      contentType: fileObj.type || "application/octet-stream",
      sizeBytes: buf.byteLength,
      body: buf,
    });

    return c.json({ attachment: record }, 201);
  });

  router.get("/attachments/:id", async (c) => {
    const inline = c.req.query("inline") === "true";
    const res = await getAttachmentResponse(c.env.DB, c.env.ATTACHMENTS, c.req.param("id"), inline);
    if (!res) {
      return c.json({ error: "Attachment not found" }, 404);
    }
    return res;
  });

  // ---------------------------------------------------------------------------
  // Addresses & Settings
  // ---------------------------------------------------------------------------

  router.get("/addresses", async (c) => {
    return c.json({ addresses: await listAddresses(c.env.DB) });
  });

  router.post("/addresses", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createAddressSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", issues: parsed.error.flatten() }, 400);
    }
    try {
      const address = await createAddress(c.env.DB, parsed.data);
      return c.json({ address }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create address";
      return c.json({ error: msg }, 400);
    }
  });

  router.patch("/addresses/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = updateAddressSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", issues: parsed.error.flatten() }, 400);
    }
    const address = await updateAddress(c.env.DB, c.req.param("id"), parsed.data);
    if (!address) {
      return c.json({ error: "Address not found" }, 404);
    }
    return c.json({ address });
  });

  router.delete("/addresses/:id", async (c) => {
    const deleted = await deleteAddress(c.env.DB, c.req.param("id"));
    if (!deleted) {
      return c.json({ error: "Address not found" }, 404);
    }
    return c.json({ ok: true });
  });

  router.get("/settings", async (c) => {
    const settings = await getSettings(
      c.env.DB,
      c.env.MAIL_DOMAIN ?? "",
      c.env.DEFAULT_AI_MODEL,
    );
    return c.json({ settings });
  });

  router.patch("/settings", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = updateSettingsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", issues: parsed.error.flatten() }, 400);
    }
    const settings = await updateSettings(c.env.DB, parsed.data, c.env.MAIL_DOMAIN ?? "");
    return c.json({ settings });
  });

  // ---------------------------------------------------------------------------
  // Built-in Cloudflare Workers AI & Digests
  // ---------------------------------------------------------------------------

  router.post("/ai/threads/:id/summary", async (c) => {
    try {
      const res = await summarizeThread(c.env.DB, c.env, c.req.param("id"), {
        force: c.req.query("force") === "true",
        actorType: "postlet_ai",
        actorLabel: "postlet-ai",
      });
      return c.json(res);
    } catch (err) {
      return handleAdminAiError(c, err);
    }
  });

  router.post("/ai/threads/:id/triage", async (c) => {
    try {
      const res = await triageThread(c.env.DB, c.env, c.req.param("id"), {
        force: c.req.query("force") === "true",
        actorType: "postlet_ai",
        actorLabel: "postlet-ai",
      });
      return c.json(res);
    } catch (err) {
      return handleAdminAiError(c, err);
    }
  });

  router.post("/ai/threads/:id/suggest-reply", async (c) => {
    const bodyRes = await parseOptionalJsonBody(c);
    if (!bodyRes.ok) {
      return c.json({ error: "Malformed JSON request body" }, 400);
    }
    const parsed = aiSuggestReplySchema.safeParse(bodyRes.data);
    if (!parsed.success) {
      return c.json({ error: "Validation failed" }, 400);
    }
    try {
      const res = await suggestReply(c.env.DB, c.env, c.req.param("id"), parsed.data.guidance);
      return c.json(res);
    } catch (err) {
      return handleAdminAiError(c, err);
    }
  });

  router.post("/ai/threads/:id/auto-reply", async (c) => {
    const bodyRes = await parseOptionalJsonBody(c);
    if (!bodyRes.ok) {
      return c.json({ error: "Malformed JSON request body" }, 400);
    }
    const parsed = aiAutoReplyInputSchema.safeParse(bodyRes.data);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", issues: parsed.error.flatten() }, 400);
    }
    const resendClient = new ResendClient(c.env.RESEND_API_KEY ?? "", options?.resendFetchFn);
    try {
      const res = await evaluateAndRunImportantAutoReply(
        c.env.DB,
        c.env.ATTACHMENTS,
        c.env,
        resendClient,
        c.req.param("id"),
        {
          callerType: "owner",
          actorLabel: "postlet-ai:auto-reply",
          modeOverride: parsed.data.modeOverride,
          instructionsOverride: parsed.data.instructionsOverride,
          force: parsed.data.force,
        },
      );
      return c.json(res);
    } catch (err) {
      return handleAdminAiError(c, err);
    }
  });

  router.get("/digests", async (c) => {
    const digests = await listDailyDigests(c.env.DB, 20);
    return c.json({ digests });
  });

  router.post("/digests/generate", async (c) => {
    const bodyRes = await parseOptionalJsonBody(c);
    if (!bodyRes.ok) {
      return c.json({ error: "Malformed JSON request body" }, 400);
    }
    const resendClient = new ResendClient(c.env.RESEND_API_KEY ?? "", options?.resendFetchFn);
    try {
      const digest = await generateDailyInboxSummary(c.env.DB, c.env, resendClient, {
        triggeredBy: "owner",
        actorType: "postlet_ai",
        actorLabel: "postlet-ai",
        sendEmailCopy: Boolean((bodyRes.data as { emailCopy?: boolean })?.emailCopy),
      });
      return c.json({ digest }, 201);
    } catch (err) {
      return handleAdminAiError(c, err);
    }
  });

  router.patch("/digests/:id/todos/:todoId", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = toggleTodoSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed" }, 400);
    }
    const updated = await toggleDigestTodo(
      c.env.DB,
      c.req.param("id"),
      c.req.param("todoId"),
      parsed.data.done,
    );
    if (!updated) {
      return c.json({ error: "Digest or To-Do item not found" }, 404);
    }
    return c.json({ digest: updated });
  });

  // ---------------------------------------------------------------------------
  // Agent Keys & Audit Logs
  // ---------------------------------------------------------------------------

  router.get("/agent-keys", async (c) => {
    return c.json({ keys: await listAgentKeys(c.env.DB) });
  });

  router.post("/agent-keys", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createAgentKeySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", issues: parsed.error.flatten() }, 400);
    }
    const origin = new URL(c.req.url).origin;
    try {
      const created = await createAgentKey(c.env.DB, parsed.data, origin);
      await recordAuditLog(c.env.DB, {
        actorType: "owner",
        actorLabel: c.get("ownerEmail") ?? "owner",
        action: "owner:create_agent_key",
        resourceType: "agent_key",
        resourceId: created.key.id,
        status: "allowed",
        details: { name: created.key.name, scope: created.key.scope },
      });
      return c.json(created, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create agent key";
      return c.json({ error: msg }, 400);
    }
  });

  router.delete("/agent-keys/:id", async (c) => {
    const keyId = c.req.param("id");
    const revoked = await revokeAgentKey(c.env.DB, keyId);
    if (!revoked) {
      return c.json({ error: "Active agent key not found" }, 404);
    }
    await recordAuditLog(c.env.DB, {
      actorType: "owner",
      actorLabel: c.get("ownerEmail") ?? "owner",
      action: "owner:revoke_agent_key",
      resourceType: "agent_key",
      resourceId: keyId,
      status: "allowed",
    });
    return c.json({ ok: true });
  });

  router.get("/audit-logs", async (c) => {
    const logs = await listAuditLogs(c.env.DB, {
      actorType: c.req.query("actorType") || undefined,
      agentKeyId: c.req.query("agentKeyId") || undefined,
      status: c.req.query("status") || undefined,
      limit: Number.parseInt(c.req.query("limit") ?? "60", 10) || 60,
      offset: Number.parseInt(c.req.query("offset") ?? "0", 10) || 0,
    });
    return c.json({ logs });
  });

  return router;
}

function handleAdminAiError(
  c: { json: (data: unknown, status?: number) => Response },
  err: unknown,
): Response {
  if (err instanceof AiDisabledError) {
    return c.json({ error: err.message, code: err.code }, 403);
  }
  if (err instanceof AiQuotaExceededError) {
    return c.json({ error: err.message, code: err.code }, 429);
  }
  const msg = err instanceof Error ? err.message : "Workers AI operation failed";
  return c.json({ error: msg }, 400);
}
