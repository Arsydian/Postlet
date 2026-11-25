/**
 * @file src/shared/schemas.ts
 * @description Zod validation schemas shared between Worker endpoints and the React UI
 * to enforce consistent API contracts and prevent malformed input.
 */

import { z } from "zod";

/** Validates an email address cleanly and normalizes case/whitespace. */
export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .email()
  .transform((val) => val.toLowerCase());

export const folderSchema = z.enum([
  "inbox",
  "pending_approval",
  "sent",
  "drafts",
  "archive",
  "trash",
]);

export const agentScopeSchema = z.enum(["read_only", "read_draft", "read_write"]);

export const builtInFunctionSchema = z.enum([
  "daily_summary",
  "important_auto_reply",
  "triage",
]);

export const createAddressSchema = z.object({
  email: emailSchema,
  displayName: z.string().trim().max(120).optional().default(""),
  isDefault: z.boolean().optional().default(false),
});

export const updateAddressSchema = z.object({
  displayName: z.string().trim().max(120).optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const ALLOWED_AI_MODELS = [
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
] as const;

export const sendOrDraftMessageSchema = z.object({
  mode: z.enum(["send", "draft", "pending_approval"]).default("send"),
  fromAddressId: z.string().trim().min(1).optional(),
  fromAddress: emailSchema.optional(),
  to: z.array(emailSchema).min(1).max(50),
  cc: z.array(emailSchema).max(50).optional().default([]),
  bcc: z.array(emailSchema).max(50).optional().default([]),
  replyTo: emailSchema.optional(),
  subject: z.string().trim().min(1).max(998),
  textBody: z.string().max(500_000).optional().default(""),
  htmlBody: z.string().max(1_000_000).optional().default(""),
  threadId: z.string().trim().min(1).optional(),
  replyToMessageId: z.string().trim().min(1).optional(),
  forwardMessageId: z.string().trim().min(1).optional(),
  attachmentIds: z.array(z.string().trim().min(1)).max(20).optional().default([]),
  trackOpensAndClicks: z.boolean().optional().default(false),
});

/**
 * Restricted outbound schema for external AI agents: omits `fromAddressId` and `attachmentIds`
 * so keys cannot bypass alias locks by ID or claim owner-staged pending uploads.
 */
export const agentSendOrDraftSchema = z.object({
  fromAddress: emailSchema.optional(),
  to: z.array(emailSchema).min(1).max(50),
  cc: z.array(emailSchema).max(50).optional().default([]),
  bcc: z.array(emailSchema).max(50).optional().default([]),
  replyTo: emailSchema.optional(),
  subject: z.string().trim().min(1).max(998),
  textBody: z.string().max(500_000).optional().default(""),
  htmlBody: z.string().max(1_000_000).optional().default(""),
  threadId: z.string().trim().min(1).max(128).optional(),
  replyToMessageId: z.string().trim().min(1).max(128).optional(),
  forwardMessageId: z.string().trim().min(1).max(128).optional(),
});

export const mcpListThreadsSchema = z.object({
  folder: folderSchema.optional(),
  unreadOnly: z.boolean().optional().default(false),
  priority: z.enum(["high", "normal", "low"]).optional(),
  category: z
    .enum(["action_required", "fyi", "newsletter", "receipt", "automated", "personal"])
    .optional(),
  limit: z.number().int().min(1).max(50).optional().default(25),
});

export const mcpSearchEmailsSchema = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(50).optional().default(25),
});

export const mcpThreadIdSchema = z.object({
  threadId: z.string().trim().min(1).max(128),
});

export const mcpTriageArgsSchema = z.object({
  threadId: z.string().trim().min(1).max(128),
  force: z.boolean().optional().default(false),
});

export const mcpDraftImportantReplySchema = z.object({
  threadId: z.string().trim().min(1).max(128),
  instructions: z.string().trim().max(2000).optional(),
  force: z.boolean().optional().default(false),
});

export const mcpTriggerAutoReplySchema = z.object({
  threadId: z.string().trim().min(1).max(128),
  mode: z.enum(["approval", "auto_send"]).optional(),
  instructions: z.string().trim().max(2000).optional(),
  force: z.boolean().optional().default(false),
});

export const approveMessageSchema = z.object({
  to: z.array(emailSchema).min(1).max(50).optional(),
  cc: z.array(emailSchema).max(50).optional(),
  bcc: z.array(emailSchema).max(50).optional(),
  subject: z.string().trim().min(1).max(998).optional(),
  textBody: z.string().max(500_000).optional(),
  htmlBody: z.string().max(1_000_000).optional(),
});

export const updateDraftMessageSchema = z.object({
  mode: z.enum(["draft", "send"]).default("draft"),
  fromAddressId: z.string().trim().min(1).optional(),
  fromAddress: emailSchema.optional(),
  to: z.array(emailSchema).min(1).max(50),
  cc: z.array(emailSchema).max(50).optional().default([]),
  bcc: z.array(emailSchema).max(50).optional().default([]),
  replyTo: emailSchema.optional(),
  subject: z.string().trim().min(1).max(998),
  textBody: z.string().max(500_000).optional().default(""),
  htmlBody: z.string().max(1_000_000).optional().default(""),
  attachmentIds: z.array(z.string().trim().min(1)).max(20).optional(),
  trackOpensAndClicks: z.boolean().optional(),
});

export const updateThreadSchema = z.object({
  folder: z.enum(["inbox", "archive", "trash"]).optional(),
  isRead: z.boolean().optional(),
});

export const createAgentKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  scope: agentScopeSchema,
  allowedAddressId: z.string().trim().min(1).nullable().optional().default(null),
  allowedRecipientDomains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Invalid domain format"),
    )
    .max(50)
    .nullable()
    .optional()
    .default(null),
  allowedFunctions: z
    .array(builtInFunctionSchema)
    .optional()
    .default(["daily_summary", "important_auto_reply", "triage"]),
  rateLimitPerHour: z.number().int().min(1).max(5000).optional().default(60),
});

/** Validates a DNS domain name cleanly and normalizes case/whitespace. */
export const domainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Invalid domain format");

export const updateSettingsSchema = z.object({
  mailDomain: z.string().trim().toLowerCase().max(500).optional(),
  mailDomains: z.array(domainNameSchema).max(30).optional(),
  catchAllEnabled: z.boolean().optional(),
  trustedImageSenders: z.array(emailSchema).max(500).optional(),
  aiEnabled: z.boolean().optional(),
  aiModel: z.enum(ALLOWED_AI_MODELS).optional(),
  aiDailyCap: z.number().int().min(1).max(2000).optional(),
  aiAutoTriageEnabled: z.boolean().optional(),
  aiDailySummaryEnabled: z.boolean().optional(),
  aiDailySummaryHour: z.number().int().min(0).max(23).optional(),
  aiDailySummaryTimezone: z.string().trim().min(1).max(80).optional(),
  aiDailySummaryEmailCopy: z.boolean().optional(),
  aiImportantAutoReplyEnabled: z.boolean().optional(),
  aiImportantAutoReplyMode: z.enum(["approval", "auto_send"]).optional(),
  aiImportantAutoReplyInstructions: z.string().trim().min(5).max(2000).optional(),
  aiImportantAutoReplyCooldownHours: z.number().int().min(1).max(720).optional(),
});

export const updateMessagePreferencesSchema = z.object({
  allowRemoteImages: z.boolean(),
});

export const toggleTodoSchema = z.object({
  done: z.boolean(),
});

export const aiSuggestReplySchema = z.object({
  guidance: z.string().trim().max(1000).optional().default(""),
});

export const aiAutoReplyInputSchema = z.object({
  modeOverride: z.enum(["approval", "auto_send"]).optional(),
  instructionsOverride: z.string().trim().max(2000).optional(),
  force: z.boolean().optional().default(false),
});
