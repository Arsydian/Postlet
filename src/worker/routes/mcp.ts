/**
 * @file src/worker/routes/mcp.ts
 * @description Streamable HTTP Model Context Protocol (MCP) endpoint (`/mcp`) allowing AI agents
 * (Claude, Cursor, Antigravity, etc.) to connect directly using scoped Postlet bearer keys.
 * Dynamically scopes `tools/list` and enforces permissions + audit logging on every `tools/call`.
 */

import { Hono } from "hono";
import {
  agentSendOrDraftSchema,
  mcpDraftImportantReplySchema,
  mcpListThreadsSchema,
  mcpSearchEmailsSchema,
  mcpThreadIdSchema,
  mcpTriageArgsSchema,
  mcpTriggerAutoReplySchema,
} from "../../shared/schemas";
import type {
  AgentKeyRecord,
  AppSettings,
} from "../../shared/types";
import type { PostletEnv, PostletVariables } from "../env";
import { agentAuthMiddleware } from "../middleware/agent-auth";
import { recordAuditLog } from "../middleware/audit";
import { getDefaultAddress, getSettings, listAddresses } from "../services/addresses";
import {
  hasAllowedFunction,
  hasMinimumScope,
  validateAgentSendGuardrails,
} from "../services/agent-keys";
import { AiDisabledError, summarizeThread, triageThread } from "../services/ai";
import {
  evaluateAndRunImportantAutoReply,
  FunctionDisabledError,
  generateDailyInboxSummary,
  getLatestDailyDigest,
} from "../services/ai-functions";
import {
  assertAgentThreadAccess,
  getThreadDetail,
  listThreads,
  sendOrDraftEmail,
} from "../services/mail";
import { ResendClient } from "../services/resend";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Builds the dynamic MCP tool catalog permitted for this specific agent key and AI settings.
 */
function buildAvailableTools(key: AgentKeyRecord, settings: AppSettings): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [
    {
      name: "list_threads",
      description:
        "List email conversation threads from Postlet folders (inbox, pending_approval, sent, drafts, archive, trash).",
      inputSchema: {
        type: "object",
        properties: {
          folder: {
            type: "string",
            enum: ["inbox", "pending_approval", "sent", "drafts", "archive", "trash"],
          },
          unreadOnly: { type: "boolean" },
          priority: { type: "string", enum: ["high", "normal", "low"] },
          category: {
            type: "string",
            enum: ["action_required", "fyi", "newsletter", "receipt", "automated", "personal"],
          },
          limit: { type: "number", minimum: 1, maximum: 50 },
        },
      },
    },
    {
      name: "read_thread",
      description:
        "Read all messages, headers, delivery status, and attachment metadata in a specific thread.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
        },
        required: ["threadId"],
      },
    },
    {
      name: "search_emails",
      description: "Full-text search across subject, senders, recipients, and email bodies.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 50 },
        },
        required: ["query"],
      },
    },
    {
      name: "list_addresses",
      description: "List active sender email aliases accessible to this key.",
      inputSchema: { type: "object", properties: {} },
    },
  ];

  if (!key.allowedAddressEmail && hasAllowedFunction(key, "daily_summary")) {
    tools.push({
      name: "get_daily_summary",
      description:
        "Retrieve the latest saved Daily Inbox Summary containing overview, To-Dos, reminders, and FYI items.",
      inputSchema: { type: "object", properties: {} },
    });
  }

  if (settings.aiEnabled && hasAllowedFunction(key, "triage")) {
    tools.push(
      {
        name: "summarize_thread",
        description: "Summarize a thread using built-in Cloudflare Workers AI.",
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            force: { type: "boolean" },
          },
          required: ["threadId"],
        },
      },
      {
        name: "triage_thread",
        description: "Classify a thread's category, priority, and summary via Cloudflare Workers AI.",
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            force: { type: "boolean" },
          },
          required: ["threadId"],
        },
      },
    );
  }

  if (
    !key.allowedAddressEmail &&
    settings.aiEnabled &&
    settings.aiDailySummaryEnabled &&
    hasAllowedFunction(key, "daily_summary")
  ) {
    tools.push({
      name: "generate_daily_summary",
      description:
        "Generate a fresh Daily Inbox Summary (overview, To-Dos, reminders) using Cloudflare Workers AI.",
      inputSchema: { type: "object", properties: {} },
    });
  }

  if (hasMinimumScope(key.scope, "read_draft")) {
    tools.push({
      name: "create_draft",
      description:
        "Queue an outbound email or reply into the owner's Pending Approval queue for human review before sending.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "array", items: { type: "string" } },
          cc: { type: "array", items: { type: "string" } },
          fromAddress: { type: "string" },
          subject: { type: "string" },
          textBody: { type: "string" },
          htmlBody: { type: "string" },
          threadId: { type: "string" },
          replyToMessageId: { type: "string" },
        },
        required: ["to", "subject"],
      },
    });

    if (
      settings.aiEnabled &&
      settings.aiImportantAutoReplyEnabled &&
      hasAllowedFunction(key, "important_auto_reply")
    ) {
      tools.push({
        name: "draft_important_reply",
        description:
          "Use the built-in Important Email Auto-Reply function to draft a contextual reply queued for owner approval.",
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            instructions: { type: "string" },
            force: { type: "boolean" },
          },
          required: ["threadId"],
        },
      });
    }
  }

  if (hasMinimumScope(key.scope, "read_write")) {
    tools.push(
      {
        name: "send_email",
        description: "Send an email immediately via Resend.",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "array", items: { type: "string" } },
            cc: { type: "array", items: { type: "string" } },
            bcc: { type: "array", items: { type: "string" } },
            fromAddress: { type: "string" },
            subject: { type: "string" },
            textBody: { type: "string" },
            htmlBody: { type: "string" },
          },
          required: ["to", "subject"],
        },
      },
      {
        name: "reply_to_thread",
        description: "Send an immediate reply inside an existing conversation thread.",
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            replyToMessageId: { type: "string" },
            to: { type: "array", items: { type: "string" } },
            subject: { type: "string" },
            textBody: { type: "string" },
            htmlBody: { type: "string" },
          },
          required: ["threadId", "replyToMessageId", "to", "subject"],
        },
      },
    );

    if (
      settings.aiEnabled &&
      settings.aiImportantAutoReplyEnabled &&
      hasAllowedFunction(key, "important_auto_reply")
    ) {
      tools.push({
        name: "trigger_important_auto_reply",
        description:
          "Execute the built-in Important Email Auto-Reply function on a thread (can auto-send when configured).",
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            mode: { type: "string", enum: ["approval", "auto_send"] },
            instructions: { type: "string" },
            force: { type: "boolean" },
          },
          required: ["threadId"],
        },
      });
    }
  }

  return tools;
}

function mcpTextResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function createMcpRoutes(resendFetchFn?: typeof fetch) {
  const router = new Hono<{ Bindings: PostletEnv; Variables: PostletVariables }>();

  router.get("/", (c) => {
    return c.json({
      service: "postlet-mcp",
      transport: "streamable-http",
      endpoint: "/mcp",
      auth: "Bearer plt_...",
    });
  });

  router.use("/", agentAuthMiddleware);

  router.post("/", async (c) => {
    const key = c.get("agentKey");
    if (!key) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    let body: JsonRpcRequest;
    try {
      body = (await c.req.json()) as JsonRpcRequest;
    } catch {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        400,
      );
    }

    const id = body.id ?? null;
    if (body.method === "notifications/initialized" || (id === null && body.method?.startsWith("notifications/"))) {
      return c.body(null, 202);
    }

    if (body.method === "initialize") {
      await recordAuditLog(c.env.DB, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
        action: "mcp:initialize",
        resourceType: "mcp",
        status: "allowed",
      });
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: {
            name: "postlet-mcp",
            version: c.env.APP_VERSION || "0.4.0",
          },
        },
      });
    }

    if (body.method === "ping") {
      await recordAuditLog(c.env.DB, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
        action: "mcp:ping",
        resourceType: "mcp",
        status: "allowed",
      });
      return c.json({ jsonrpc: "2.0", id, result: {} });
    }

    const settings = await getSettings(
      c.env.DB,
      c.env.MAIL_DOMAIN ?? "",
      c.env.DEFAULT_AI_MODEL,
    );

    if (body.method === "tools/list") {
      await recordAuditLog(c.env.DB, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
        action: "mcp:tools_list",
        resourceType: "mcp",
        status: "allowed",
      });
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: buildAvailableTools(key, settings),
        },
      });
    }

    if (body.method === "tools/call") {
      const toolName = String(body.params?.name ?? "");
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
      const resendClient = new ResendClient(c.env.RESEND_API_KEY ?? "", resendFetchFn);

      try {
        const result = await executeMcpTool(
          c.env,
          key,
          settings,
          resendClient,
          toolName,
          args,
        );
        return c.json({ jsonrpc: "2.0", id, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Tool execution failed";
        await recordAuditLog(c.env.DB, {
          actorType: "agent_key",
          agentKeyId: key.id,
          actorLabel: key.name,
          action: `mcp:${toolName}`,
          resourceType: "mcp_tool",
          status:
            err instanceof AiDisabledError || err instanceof FunctionDisabledError || message.includes("Permission denied")
              ? "denied"
              : "error",
          details: { error: message },
        });
        return c.json({
          jsonrpc: "2.0",
          id,
          result: mcpTextResult({ error: message }, true),
        });
      }
    }

    return c.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${body.method ?? ""}` },
    });
  });

  return router;
}

async function executeMcpTool(
  env: PostletEnv,
  key: AgentKeyRecord,
  _settings: AppSettings,
  resendClient: ResendClient,
  toolName: string,
  args: Record<string, unknown>,
) {
  const db = env.DB;

  switch (toolName) {
    case "list_threads": {
      const parsed = mcpListThreadsSchema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.message}`);
      }
      const threads = await listThreads(db, {
        folder: parsed.data.folder,
        unreadOnly: parsed.data.unreadOnly,
        priority: parsed.data.priority,
        category: parsed.data.category,
        limit: parsed.data.limit,
        scopedAddressEmail: key.allowedAddressEmail,
      });
      await recordAuditLog(db, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
        action: "mcp:list_threads",
        resourceType: "thread",
        status: "allowed",
        details: { count: threads.length },
      });
      return mcpTextResult({ threads });
    }

    case "read_thread": {
      const parsed = mcpThreadIdSchema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.message}`);
      }
      const thread = await getThreadDetail(db, parsed.data.threadId, key.allowedAddressEmail);
      if (!thread) {
        throw new Error("Thread not found or outside key's scoped address");
      }
      await recordAuditLog(db, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
        action: "mcp:read_thread",
        resourceType: "thread",
        resourceId: parsed.data.threadId,
        status: "allowed",
      });
      return mcpTextResult({ thread });
    }

    case "search_emails": {
      const parsed = mcpSearchEmailsSchema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.message}`);
      }
      const threads = await listThreads(db, {
        q: parsed.data.query,
        limit: parsed.data.limit,
        scopedAddressEmail: key.allowedAddressEmail,
      });
      await recordAuditLog(db, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
        action: "mcp:search_emails",
        resourceType: "thread",
        status: "allowed",
        details: { query: parsed.data.query, count: threads.length },
      });
      return mcpTextResult({ threads });
    }

    case "list_addresses": {
      const all = await listAddresses(db);
      const filtered = key.allowedAddressEmail
        ? all.filter((a) => a.email.toLowerCase() === key.allowedAddressEmail!.toLowerCase())
        : all.filter((a) => a.isActive);
      await recordAuditLog(db, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
        action: "mcp:list_addresses",
        resourceType: "address",
        status: "allowed",
      });
      return mcpTextResult({ addresses: filtered });
    }

    case "get_daily_summary": {
      if (!hasAllowedFunction(key, "daily_summary")) {
        throw new Error("Permission denied: key lacks 'daily_summary' function permission");
      }
      if (key.allowedAddressEmail) {
        throw new Error("Permission denied: Daily summary is not available for alias-scoped keys");
      }
      const digest = await getLatestDailyDigest(db);
      await recordAuditLog(db, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
        action: "mcp:get_daily_summary",
        resourceType: "digest",
        resourceId: digest?.id ?? null,
        status: "allowed",
      });
      return mcpTextResult({ digest });
    }

    case "generate_daily_summary": {
      if (!hasAllowedFunction(key, "daily_summary")) {
        throw new Error("Permission denied: key lacks 'daily_summary' function permission");
      }
      if (key.allowedAddressEmail) {
        throw new Error("Permission denied: Daily summary is not available for alias-scoped keys");
      }
      const digest = await generateDailyInboxSummary(db, env, resendClient, {
        triggeredBy: `agent:${key.name}`,
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
      });
      return mcpTextResult({ digest });
    }

    case "summarize_thread": {
      if (!hasAllowedFunction(key, "triage")) {
        throw new Error("Permission denied: key lacks 'triage' function permission");
      }
      const parsed = mcpTriageArgsSchema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.message}`);
      }
      const thread = await getThreadDetail(db, parsed.data.threadId, key.allowedAddressEmail);
      if (!thread) throw new Error("Thread not found or outside key's scoped address");
      const summary = await summarizeThread(db, env, parsed.data.threadId, {
        force: parsed.data.force,
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
      });
      return mcpTextResult(summary);
    }

    case "triage_thread": {
      if (!hasAllowedFunction(key, "triage")) {
        throw new Error("Permission denied: key lacks 'triage' function permission");
      }
      const parsed = mcpTriageArgsSchema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.message}`);
      }
      const thread = await getThreadDetail(db, parsed.data.threadId, key.allowedAddressEmail);
      if (!thread) throw new Error("Thread not found or outside key's scoped address");
      const triage = await triageThread(db, env, parsed.data.threadId, {
        force: parsed.data.force,
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
      });
      return mcpTextResult(triage);
    }

    case "create_draft": {
      if (!hasMinimumScope(key.scope, "read_draft")) {
        throw new Error("Permission denied: 'create_draft' requires 'read_draft' or 'read_write' scope");
      }
      const parsed = agentSendOrDraftSchema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.message}`);
      }
      const fromAddress =
        key.allowedAddressEmail ||
        parsed.data.fromAddress ||
        (await getDefaultAddress(db))?.email ||
        "";

      const guardrailError = validateAgentSendGuardrails(key, fromAddress, [
        ...parsed.data.to,
        ...parsed.data.cc,
        ...parsed.data.bcc,
      ]);
      if (guardrailError) {
        throw new Error(`Permission denied: ${guardrailError}`);
      }

      await assertAgentThreadAccess(db, key.allowedAddressEmail, parsed.data);

      const created = await sendOrDraftEmail(
        db,
        env.ATTACHMENTS,
        resendClient,
        {
          mode: "pending_approval",
          fromAddress: fromAddress || undefined,
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

      await recordAuditLog(db, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
        action: "mcp:create_draft",
        resourceType: "message",
        resourceId: created.message.id,
        status: "allowed",
        details: { to: parsed.data.to, status: created.message.status },
      });

      return mcpTextResult({ message: created.message, threadId: created.threadId });
    }

    case "draft_important_reply": {
      if (!hasMinimumScope(key.scope, "read_draft")) {
        throw new Error("Permission denied: requires 'read_draft' or 'read_write' scope");
      }
      if (!hasAllowedFunction(key, "important_auto_reply")) {
        throw new Error("Permission denied: key lacks 'important_auto_reply' function permission");
      }
      const parsed = mcpDraftImportantReplySchema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.message}`);
      }
      const thread = await getThreadDetail(db, parsed.data.threadId, key.allowedAddressEmail);
      if (!thread) throw new Error("Thread not found or outside key's scoped address");

      const res = await evaluateAndRunImportantAutoReply(
        db,
        env.ATTACHMENTS,
        env,
        resendClient,
        parsed.data.threadId,
        {
          callerType: "agent",
          agentKey: key,
          agentScope: "read_draft", // Always queue for approval via draft tool
          agentKeyId: key.id,
          actorLabel: key.name,
          modeOverride: "approval",
          instructionsOverride: parsed.data.instructions,
          force: parsed.data.force,
        },
      );
      return mcpTextResult(res);
    }

    case "send_email":
    case "reply_to_thread": {
      if (!hasMinimumScope(key.scope, "read_write")) {
        throw new Error(`Permission denied: '${toolName}' requires 'read_write' scope`);
      }
      const parsed = agentSendOrDraftSchema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.message}`);
      }
      const fromAddress =
        key.allowedAddressEmail ||
        parsed.data.fromAddress ||
        (await getDefaultAddress(db))?.email ||
        "";

      const guardrailError = validateAgentSendGuardrails(key, fromAddress, [
        ...parsed.data.to,
        ...parsed.data.cc,
        ...parsed.data.bcc,
      ]);
      if (guardrailError) {
        throw new Error(`Permission denied: ${guardrailError}`);
      }

      await assertAgentThreadAccess(db, key.allowedAddressEmail, parsed.data);

      const sent = await sendOrDraftEmail(
        db,
        env.ATTACHMENTS,
        resendClient,
        {
          mode: "send",
          fromAddress: fromAddress || undefined,
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

      await recordAuditLog(db, {
        actorType: "agent_key",
        agentKeyId: key.id,
        actorLabel: key.name,
        action: `mcp:${toolName}`,
        resourceType: "message",
        resourceId: sent.message.id,
        status: "allowed",
        details: { to: parsed.data.to, resendEmailId: sent.message.resendEmailId },
      });

      return mcpTextResult({ message: sent.message, threadId: sent.threadId });
    }

    case "trigger_important_auto_reply": {
      if (!hasMinimumScope(key.scope, "read_write")) {
        throw new Error("Permission denied: 'trigger_important_auto_reply' requires 'read_write' scope");
      }
      if (!hasAllowedFunction(key, "important_auto_reply")) {
        throw new Error("Permission denied: key lacks 'important_auto_reply' function permission");
      }
      const parsed = mcpTriggerAutoReplySchema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.message}`);
      }
      const thread = await getThreadDetail(db, parsed.data.threadId, key.allowedAddressEmail);
      if (!thread) throw new Error("Thread not found or outside key's scoped address");

      const res = await evaluateAndRunImportantAutoReply(
        db,
        env.ATTACHMENTS,
        env,
        resendClient,
        parsed.data.threadId,
        {
          callerType: "agent",
          agentKey: key,
          agentScope: key.scope,
          agentKeyId: key.id,
          actorLabel: key.name,
          modeOverride: parsed.data.mode,
          instructionsOverride: parsed.data.instructions,
          force: parsed.data.force,
        },
      );
      return mcpTextResult(res);
    }

    default:
      throw new Error(`Unknown MCP tool: ${toolName}`);
  }
}
