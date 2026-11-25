/**
 * @file src/worker/services/mail.ts
 * @description Core mail domain engine: RFC 5322 conversation threading, inbound Resend webhook
 * ingestion, outbound sending/drafting, Pending Approval workflows, FTS5 search, and folder management.
 */

import type {
  AiCategory,
  AiPriority,
  AttachmentRecord,
  DeliveryEvent,
  FolderCounts,
  FolderName,
  MessageDirection,
  MessageRecord,
  MessageStatus,
  ThreadDetail,
  ThreadSummary,
} from "../../shared/types";
import {
  findAddressByEmail,
  findAddressById,
  getDefaultAddress,
  getSettings,
  listAddresses,
} from "./addresses";
import {
  claimPendingAttachments,
  deleteAttachmentsForMessage,
  ingestResendAttachments,
  listAttachmentsByMessageIds,
  loadAttachmentsForResend,
  storeAttachment,
  syncDraftAttachments,
} from "./attachments";
import type { ResendClient, ResendWebhookAttachmentMeta } from "./resend";
import {
  instrumentHtmlWithSelfHostedTracking,
  type SelfHostedTrackingConfig,
} from "./tracking";
import type { MailTransport } from "./transports";

interface ThreadRow {
  id: string;
  subject: string;
  snippet: string;
  participants_json: string;
  recipient_address: string;
  folder: string;
  last_message_at: string;
  message_count: number;
  unread_count: number;
  ai_summary: string | null;
  ai_category: AiCategory | null;
  ai_priority: AiPriority | null;
  ai_updated_at: string | null;
  auto_replied_at: string | null;
  latest_status?: MessageStatus | null;
  pending_count?: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  resend_email_id: string | null;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  direction: MessageDirection;
  status: MessageStatus;
  from_address: string;
  from_name: string;
  to_addresses_json: string;
  cc_addresses_json: string;
  bcc_addresses_json: string;
  reply_to: string | null;
  subject: string;
  text_body: string;
  html_body: string;
  headers_json: string;
  is_read: number;
  folder: string;
  created_by_agent_key_id: string | null;
  created_by_actor: string;
  delivery_error: string | null;
  delivery_events_json: string;
  created_at: string;
  updated_at: string;
}

/**
 * Parses `"Display Name <user@domain.com>"` or `"user@domain.com"` into normalized fields.
 */
export function parseEmailAddress(raw: string): { email: string; name: string } {
  const trimmed = raw.trim();
  const angleMatch = trimmed.match(/^(?:"?([^"]*)"?\s*)?<([^<>@\s]+@[^<>@\s]+)>$/);
  if (angleMatch) {
    return {
      name: (angleMatch[1] ?? "").trim(),
      email: angleMatch[2].trim().toLowerCase(),
    };
  }
  return {
    name: "",
    email: trimmed.toLowerCase(),
  };
}

/**
 * Strips common `Re:` / `Fwd:` prefixes for fallback subject-based threading.
 */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(?:\s*(?:re|fwd?|aw|sv)\s*(?:\[\d+\])?:\s*)+/i, "")
    .trim()
    .toLowerCase();
}

/**
 * Generates a concise preview snippet from plain text or HTML body.
 */
export function createSnippet(textBody: string, htmlBody: string): string {
  const source =
    textBody.trim().length > 0
      ? textBody
      : htmlBody
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<[^>]+>/g, " ");
  return source.replace(/\s+/g, " ").trim().slice(0, 180);
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapThreadRow(row: ThreadRow): ThreadSummary {
  return {
    id: row.id,
    subject: row.subject,
    snippet: row.snippet,
    participants: safeJsonParse<string[]>(row.participants_json, []),
    recipientAddress: row.recipient_address,
    folder: row.folder,
    lastMessageAt: row.last_message_at,
    messageCount: row.message_count,
    unreadCount: row.unread_count,
    aiSummary: row.ai_summary,
    aiCategory: row.ai_category,
    aiPriority: row.ai_priority,
    aiUpdatedAt: row.ai_updated_at,
    autoRepliedAt: row.auto_replied_at,
    latestStatus: row.latest_status ?? null,
    hasPendingApproval: (row.pending_count ?? 0) > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessageRow(row: MessageRow, attachments: AttachmentRecord[]): MessageRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    resendEmailId: row.resend_email_id,
    rfcMessageId: row.rfc_message_id,
    inReplyTo: row.in_reply_to,
    referencesHeader: row.references_header,
    direction: row.direction,
    status: row.status,
    fromAddress: row.from_address,
    fromName: row.from_name,
    toAddresses: safeJsonParse<string[]>(row.to_addresses_json, []),
    ccAddresses: safeJsonParse<string[]>(row.cc_addresses_json, []),
    bccAddresses: safeJsonParse<string[]>(row.bcc_addresses_json, []),
    replyTo: row.reply_to,
    subject: row.subject,
    textBody: row.text_body,
    htmlBody: row.html_body,
    headers: safeJsonParse<Record<string, string>>(row.headers_json, {}),
    isRead: row.is_read === 1,
    folder: row.folder,
    createdByAgentKeyId: row.created_by_agent_key_id,
    createdByActor: row.created_by_actor,
    deliveryError: row.delivery_error,
    deliveryEvents: safeJsonParse<DeliveryEvent[]>(row.delivery_events_json, []),
    attachments,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Normalizes RFC header lookup keys to lowercase so lookups work regardless of casing.
 */
function normalizeHeaders(headers?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string") {
      out[k.toLowerCase()] = v;
    }
  }
  return out;
}

/** Strips CR/LF characters to prevent email header injection. */
function stripCrlf(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Verifies that any caller-supplied thread or parent message references belong to
 * `scopedAddressEmail` when an alias-locked agent key creates a draft, send, or reply.
 */
export async function assertAgentThreadAccess(
  db: D1Database,
  scopedAddressEmail: string | null | undefined,
  refs: { threadId?: string; replyToMessageId?: string; forwardMessageId?: string },
): Promise<void> {
  if (!scopedAddressEmail) return;
  const targetEmail = scopedAddressEmail.trim().toLowerCase();

  if (refs.threadId) {
    const row = await db
      .prepare(`SELECT recipient_address FROM threads WHERE id = ?`)
      .bind(refs.threadId)
      .first<{ recipient_address: string }>();
    if (!row || row.recipient_address.toLowerCase() !== targetEmail) {
      throw new Error("Access denied: target thread is outside this key's scoped address");
    }
  }

  for (const msgId of [refs.replyToMessageId, refs.forwardMessageId]) {
    if (!msgId) continue;
    const row = await db
      .prepare(
        `SELECT t.recipient_address
         FROM messages m
         JOIN threads t ON t.id = m.thread_id
         WHERE m.id = ?`,
      )
      .bind(msgId)
      .first<{ recipient_address: string }>();
    if (!row || row.recipient_address.toLowerCase() !== targetEmail) {
      throw new Error("Access denied: referenced message is outside this key's scoped address");
    }
  }
}

/**
 * Resolves an existing thread via RFC 5322 `In-Reply-To` / `References` headers or normalized
 * subject + shared external participant overlap on the same recipient address, or generates a new thread ID.
 */
async function resolveThreadId(
  db: D1Database,
  params: {
    inReplyTo: string | null;
    referencesHeader: string | null;
    subject: string;
    recipientAddress: string;
    externalParticipants: string[];
  },
): Promise<{ threadId: string; isNew: boolean }> {
  const candidateRfcIds: string[] = [];
  if (params.inReplyTo) {
    candidateRfcIds.push(params.inReplyTo.trim());
  }
  if (params.referencesHeader) {
    for (const token of params.referencesHeader.split(/\s+/)) {
      const cleaned = token.trim();
      if (cleaned && !candidateRfcIds.includes(cleaned)) {
        candidateRfcIds.push(cleaned);
      }
    }
  }

  if (candidateRfcIds.length > 0) {
    const placeholders = candidateRfcIds.map(() => "?").join(", ");
    const hit = await db
      .prepare(
        `SELECT thread_id FROM messages WHERE rfc_message_id IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(...candidateRfcIds)
      .first<{ thread_id: string }>();
    if (hit) {
      return { threadId: hit.thread_id, isNew: false };
    }
  }

  // Fallback: match recent threads on the same recipient address with identical normalized subject
  // AND at least one overlapping external participant (prevents unrelated senders merging threads).
  const normSubj = normalizeSubject(params.subject);
  if (normSubj.length > 0 && params.externalParticipants.length > 0) {
    const { results } = await db
      .prepare(
        `SELECT id, subject, participants_json
         FROM threads
         WHERE folder != 'trash' AND lower(recipient_address) = ?
         ORDER BY last_message_at DESC
         LIMIT 40`,
      )
      .bind(params.recipientAddress.toLowerCase())
      .all<{ id: string; subject: string; participants_json: string }>();

    const externalSet = new Set(params.externalParticipants.map((p) => p.toLowerCase()));
    for (const row of results ?? []) {
      if (normalizeSubject(row.subject) !== normSubj) continue;
      const existingParticipants = safeJsonParse<string[]>(row.participants_json, []);
      if (existingParticipants.some((p) => externalSet.has(p.toLowerCase()))) {
        return { threadId: row.id, isNew: false };
      }
    }
  }

  return { threadId: crypto.randomUUID(), isNew: true };
}

export interface InboundWebhookData {
  email_id: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string | null;
  html?: string | null;
  headers?: Record<string, string>;
  message_id?: string;
  created_at?: string;
  attachments?: ResendWebhookAttachmentMeta[];
}

export interface IngestInboundResult {
  created: boolean;
  ignored: boolean;
  ignoreReason?: string;
  threadId?: string;
  messageId?: string;
}

export interface DirectInboundAttachmentInput {
  filename: string;
  contentType: string;
  contentDisposition?: string;
  contentId?: string | null;
  data: Uint8Array;
}

export interface DirectInboundEmailInput {
  providerMessageId: string;
  fromAddress: string;
  fromName?: string;
  toAddresses: string[];
  ccAddresses?: string[];
  bccAddresses?: string[];
  replyTo?: string | null;
  subject?: string;
  textBody?: string | null;
  htmlBody?: string | null;
  headers?: Record<string, string>;
  rfcMessageId?: string | null;
  createdAt?: string;
  attachments?: DirectInboundAttachmentInput[];
  envMailDomain?: string;
}

interface NormalizedInboundRecord {
  providerMessageId: string;
  parsedFrom: { email: string; name: string };
  toList: string[];
  ccList: string[];
  bccList: string[];
  replyToHeader: string | null;
  subject: string;
  textBody: string;
  htmlBody: string;
  normalizedHeaders: Record<string, string>;
  rfcMessageId: string;
  inReplyTo: string | null;
  referencesHeader: string | null;
  messageTimestamp: string;
}

async function persistNormalizedInboundEmail(
  db: D1Database,
  normalized: NormalizedInboundRecord,
  envMailDomain: string,
  saveAttachments?: (messageId: string) => Promise<void>,
): Promise<IngestInboundResult> {
  // Determine recipient address and enforce catch-all + configured multi-domain rules.
  const settings = await getSettings(db, envMailDomain);
  const candidates = [...normalized.toList, ...normalized.ccList].filter(Boolean);

  let matchedRecipient = candidates[0] ?? "";
  let matchedConfiguredAddress = false;
  for (const candidate of candidates) {
    const found = await findAddressByEmail(db, candidate);
    if (found && found.isActive) {
      matchedRecipient = found.email;
      matchedConfiguredAddress = true;
      break;
    }
  }

  if (!matchedConfiguredAddress) {
    if (!settings.catchAllEnabled) {
      return {
        created: false,
        ignored: true,
        ignoreReason: "Recipient does not match any active configured address and catch-all is disabled",
      };
    }
    if (settings.mailDomains.length > 0 && candidates.length > 0) {
      const domainSet = new Set(settings.mailDomains.map((d) => d.toLowerCase()));
      const matchingDomainCandidate = candidates.find((addr) =>
        domainSet.has((addr.split("@")[1] ?? "").toLowerCase()),
      );
      if (!matchingDomainCandidate) {
        return {
          created: false,
          ignored: true,
          ignoreReason: "Recipient domain does not match configured catch-all domains",
        };
      }
      matchedRecipient = matchingDomainCandidate;
    }
  }

  const allParticipants = Array.from(
    new Set([normalized.parsedFrom.email, ...normalized.toList, ...normalized.ccList].filter(Boolean)),
  );
  const ownedAddresses = await listAddresses(db);
  const ownedSet = new Set<string>([
    ...ownedAddresses.map((a) => a.email.toLowerCase()),
    ...normalized.toList.map((e) => e.toLowerCase()),
    matchedRecipient.toLowerCase(),
  ]);
  const externalParticipants = allParticipants.filter((p) => !ownedSet.has(p.toLowerCase()));

  const { threadId, isNew } = await resolveThreadId(db, {
    inReplyTo: normalized.inReplyTo,
    referencesHeader: normalized.referencesHeader,
    subject: normalized.subject,
    recipientAddress: matchedRecipient,
    externalParticipants,
  });

  const now = new Date().toISOString();
  const messageId = crypto.randomUUID();
  const snippet = createSnippet(normalized.textBody, normalized.htmlBody);

  if (isNew) {
    await db
      .prepare(
        `INSERT INTO threads
         (id, subject, snippet, participants_json, recipient_address, folder, last_message_at,
          message_count, unread_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'inbox', ?, 1, 1, ?, ?)`,
      )
      .bind(
        threadId,
        normalized.subject,
        snippet,
        JSON.stringify(allParticipants),
        matchedRecipient,
        normalized.messageTimestamp,
        now,
        now,
      )
      .run();
  } else {
    const existingThread = await db
      .prepare(`SELECT participants_json, message_count, unread_count, recipient_address FROM threads WHERE id = ?`)
      .bind(threadId)
      .first<{
        participants_json: string;
        message_count: number;
        unread_count: number;
        recipient_address: string;
      }>();

    const mergedParticipants = Array.from(
      new Set([
        ...safeJsonParse<string[]>(existingThread?.participants_json ?? "[]", []),
        ...allParticipants,
      ]),
    );

    await db
      .prepare(
        `UPDATE threads
         SET snippet = ?,
             participants_json = ?,
             recipient_address = ?,
             folder = 'inbox',
             last_message_at = ?,
             message_count = message_count + 1,
             unread_count = unread_count + 1,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        snippet,
        JSON.stringify(mergedParticipants),
        existingThread?.recipient_address || matchedRecipient,
        normalized.messageTimestamp,
        now,
        threadId,
      )
      .run();
  }

  await db
    .prepare(
      `INSERT INTO messages
       (id, thread_id, resend_email_id, rfc_message_id, in_reply_to, references_header,
        direction, status, from_address, from_name, to_addresses_json, cc_addresses_json,
        bcc_addresses_json, reply_to, subject, text_body, html_body, headers_json,
        is_read, folder, created_by_agent_key_id, created_by_actor, delivery_events_json,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'inbound', 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'inbox', NULL, 'inbound', '[]', ?, ?)`,
    )
    .bind(
      messageId,
      threadId,
      normalized.providerMessageId,
      normalized.rfcMessageId,
      normalized.inReplyTo,
      normalized.referencesHeader,
      normalized.parsedFrom.email,
      normalized.parsedFrom.name,
      JSON.stringify(normalized.toList),
      JSON.stringify(normalized.ccList),
      JSON.stringify(normalized.bccList),
      normalized.replyToHeader,
      normalized.subject,
      normalized.textBody,
      normalized.htmlBody,
      JSON.stringify(normalized.normalizedHeaders),
      normalized.messageTimestamp,
      now,
    )
    .run();

  if (saveAttachments) {
    await saveAttachments(messageId);
  }

  return {
    created: true,
    ignored: false,
    threadId,
    messageId,
  };
}

/**
 * Ingests an inbound email directly from parsed MIME content (e.g., Cloudflare Email Routing
 * `email()` Worker handler + `postal-mime`), enforcing idempotency and multi-domain catch-all rules.
 */
export async function ingestDirectInboundEmail(
  db: D1Database,
  r2: R2Bucket,
  input: DirectInboundEmailInput,
): Promise<IngestInboundResult> {
  const existing = await db
    .prepare(`SELECT id, thread_id FROM messages WHERE resend_email_id = ?`)
    .bind(input.providerMessageId)
    .first<{ id: string; thread_id: string }>();

  if (existing) {
    return {
      created: false,
      ignored: false,
      threadId: existing.thread_id,
      messageId: existing.id,
    };
  }

  const normalizedHeaders = normalizeHeaders(input.headers);
  const parsedFrom = parseEmailAddress(input.fromAddress);
  const fromEmail = parsedFrom.email;
  const fromName = input.fromName?.trim() || parsedFrom.name;
  const rfcMessageId =
    input.rfcMessageId?.trim() ||
    normalizedHeaders["message-id"] ||
    `<${input.providerMessageId}@cloudflare.inbound>`;
  const replyToHeader = input.replyTo
    ? parseEmailAddress(input.replyTo).email
    : normalizedHeaders["reply-to"]
      ? parseEmailAddress(normalizedHeaders["reply-to"]).email
      : null;

  const attachments = input.attachments ?? [];

  return persistNormalizedInboundEmail(
    db,
    {
      providerMessageId: input.providerMessageId,
      parsedFrom: { email: fromEmail, name: fromName },
      toList: input.toAddresses.map((e) => parseEmailAddress(e).email).filter(Boolean),
      ccList: (input.ccAddresses ?? []).map((e) => parseEmailAddress(e).email).filter(Boolean),
      bccList: (input.bccAddresses ?? []).map((e) => parseEmailAddress(e).email).filter(Boolean),
      replyToHeader,
      subject: (input.subject ?? "(no subject)").trim() || "(no subject)",
      textBody: input.textBody ?? "",
      htmlBody: input.htmlBody ?? "",
      normalizedHeaders,
      rfcMessageId,
      inReplyTo: normalizedHeaders["in-reply-to"] ?? null,
      referencesHeader: normalizedHeaders["references"] ?? null,
      messageTimestamp: input.createdAt || new Date().toISOString(),
    },
    input.envMailDomain ?? "",
    attachments.length > 0
      ? async (messageId) => {
          for (const att of attachments) {
            await storeAttachment(db, r2, {
              messageId,
              filename: att.filename || "attachment.bin",
              contentType: att.contentType || "application/octet-stream",
              sizeBytes: att.data.byteLength,
              body: att.data,
              contentDisposition: att.contentDisposition || "attachment",
              contentId: att.contentId ?? null,
            });
          }
        }
      : undefined,
  );
}

/**
 * Ingests an inbound `email.received` Resend webhook idempotently, fetching full email content
 * via Resend Receiving API, checking catch-all vs. configured addresses, creating/updating the
 * conversation thread, and streaming attachments into R2.
 */
export async function ingestInboundEmail(
  db: D1Database,
  r2: R2Bucket,
  resendClient: ResendClient,
  webhookData: InboundWebhookData,
  envMailDomain = "",
): Promise<IngestInboundResult> {
  // Idempotency guard so webhook retries never create duplicate messages or refetch from Resend.
  const existing = await db
    .prepare(`SELECT id, thread_id FROM messages WHERE resend_email_id = ?`)
    .bind(webhookData.email_id)
    .first<{ id: string; thread_id: string }>();

  if (existing) {
    return {
      created: false,
      ignored: false,
      threadId: existing.thread_id,
      messageId: existing.id,
    };
  }

  // Fetch full body/headers from Resend Receiving API when available; fall back to webhook payload.
  let receivedDetail: Partial<InboundWebhookData> = {};
  try {
    receivedDetail = await resendClient.getReceivedEmail(webhookData.email_id);
  } catch (err) {
    // Only fail if neither the webhook nor the receiving API provided body/headers.
    if (webhookData.text === undefined && webhookData.html === undefined) {
      throw err;
    }
  }

  const rawFrom = receivedDetail.from || webhookData.from;
  const parsedFrom = parseEmailAddress(rawFrom);
  const toList = (receivedDetail.to ?? webhookData.to ?? []).map(
    (addr) => parseEmailAddress(addr).email,
  );
  const ccList = (receivedDetail.cc ?? webhookData.cc ?? []).map(
    (addr) => parseEmailAddress(addr).email,
  );
  const bccList = (receivedDetail.bcc ?? webhookData.bcc ?? []).map(
    (addr) => parseEmailAddress(addr).email,
  );

  const normalizedHeaders = normalizeHeaders(receivedDetail.headers ?? webhookData.headers);
  const rfcMessageId =
    receivedDetail.message_id ||
    webhookData.message_id ||
    normalizedHeaders["message-id"] ||
    `<${webhookData.email_id}@resend.inbound>`;
  const replyToHeader = normalizedHeaders["reply-to"]
    ? parseEmailAddress(normalizedHeaders["reply-to"]).email
    : null;
  const attachmentMeta = receivedDetail.attachments ?? webhookData.attachments ?? [];

  return persistNormalizedInboundEmail(
    db,
    {
      providerMessageId: webhookData.email_id,
      parsedFrom,
      toList,
      ccList,
      bccList,
      replyToHeader,
      subject:
        (receivedDetail.subject ?? webhookData.subject ?? "(no subject)").trim() || "(no subject)",
      textBody: receivedDetail.text ?? webhookData.text ?? "",
      htmlBody: receivedDetail.html ?? webhookData.html ?? "",
      normalizedHeaders,
      rfcMessageId,
      inReplyTo: normalizedHeaders["in-reply-to"] ?? null,
      referencesHeader: normalizedHeaders["references"] ?? null,
      messageTimestamp: receivedDetail.created_at || webhookData.created_at || new Date().toISOString(),
    },
    envMailDomain,
    attachmentMeta.length > 0
      ? (messageId) =>
          ingestResendAttachments(
            db,
            r2,
            resendClient,
            messageId,
            webhookData.email_id,
            attachmentMeta,
          ).then(() => undefined)
      : undefined,
  );
}

function escapeHtmlForEmail(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plainTextToEmailHtml(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "<p></p>";
  return normalized
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtmlForEmail(para).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

/**
 * Appends a visually hidden link inside an HTML email body (converting plain-text-only messages
 * to basic HTML when needed) so Resend Click & Open tracking wraps an active link for every tracked send.
 */
function appendHiddenResendTrackingLink(
  htmlBody: string,
  textBody: string,
  trackingUrl: string,
): string {
  const baseHtml = htmlBody.trim() ? htmlBody : plainTextToEmailHtml(textBody);
  const hiddenBlock = `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;" aria-hidden="true"><a href="${escapeHtmlForEmail(trackingUrl)}" tabindex="-1" style="color:transparent;text-decoration:none;font-size:1px;line-height:1px;">&#8203;</a></div>`;
  if (/<\/body>/i.test(baseHtml)) {
    return baseHtml.replace(/<\/body>/i, `${hiddenBlock}</body>`);
  }
  return `${baseHtml}\n${hiddenBlock}`;
}

/**
 * Records an `email.opened` or `email.clicked` engagement event by local `messages.id`
 * for self-hosted HMAC-signed tracking endpoints without modifying message delivery status.
 */
export async function recordEngagementByMessageId(
  db: D1Database,
  messageId: string,
  eventType: "email.opened" | "email.clicked",
  detail?: string,
  timestamp?: string,
): Promise<{ updated: boolean }> {
  const row = await db
    .prepare(`SELECT id, delivery_events_json FROM messages WHERE id = ?`)
    .bind(messageId)
    .first<{ id: string; delivery_events_json: string }>();
  if (!row) {
    return { updated: false };
  }

  const events = safeJsonParse<DeliveryEvent[]>(row.delivery_events_json, []);
  events.push({
    type: eventType,
    timestamp: timestamp || new Date().toISOString(),
    ...(detail ? { detail } : {}),
  });

  await db
    .prepare(`UPDATE messages SET delivery_events_json = ?, updated_at = ? WHERE id = ?`)
    .bind(JSON.stringify(events), new Date().toISOString(), row.id)
    .run();

  return { updated: true };
}

/**
 * Applies outbound delivery lifecycle and engagement webhook/queue events (`email.sent`,
 * `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`,
 * `email.opened`, `email.clicked`) onto the matching message row.
 */
export async function applyDeliveryWebhookEvent(
  db: D1Database,
  eventType: string,
  eventData: {
    email_id?: string;
    bounce?: { message?: string; subType?: string; type?: string };
    reason?: string;
    click?: { link?: string; ipAddress?: string; timestamp?: string };
  },
  createdAt?: string,
): Promise<{ updated: boolean; messageId?: string; status?: MessageStatus }> {
  const emailId = eventData.email_id;
  if (!emailId) {
    return { updated: false };
  }

  const row = await db
    .prepare(`SELECT id, status, delivery_events_json FROM messages WHERE resend_email_id = ?`)
    .bind(emailId)
    .first<{ id: string; status: MessageStatus; delivery_events_json: string }>();

  if (!row) {
    return { updated: false };
  }

  const events = safeJsonParse<DeliveryEvent[]>(row.delivery_events_json, []);

  if (eventType === "email.opened" || eventType === "email.clicked") {
    const clickDetail = eventType === "email.clicked" ? eventData.click?.link?.trim() : undefined;
    events.push({
      type: eventType,
      timestamp: createdAt || new Date().toISOString(),
      ...(clickDetail ? { detail: clickDetail } : {}),
    });

    await db
      .prepare(`UPDATE messages SET delivery_events_json = ?, updated_at = ? WHERE id = ?`)
      .bind(JSON.stringify(events), new Date().toISOString(), row.id)
      .run();

    return { updated: true, messageId: row.id, status: row.status };
  }

  const statusMap: Record<string, MessageStatus> = {
    "email.sent": "sent",
    "email.delivered": "delivered",
    "email.delivery_delayed": "delayed",
    "email.bounced": "bounced",
    "email.complained": "complained",
  };

  const nextStatus = statusMap[eventType];
  if (!nextStatus) {
    return { updated: false };
  }

  const detail =
    eventData.bounce?.message ||
    eventData.reason ||
    (eventData.bounce?.type ? `${eventData.bounce.type}/${eventData.bounce.subType ?? ""}` : undefined);

  events.push({
    type: eventType,
    timestamp: createdAt || new Date().toISOString(),
    ...(detail ? { detail } : {}),
  });

  const deliveryError =
    nextStatus === "bounced" || nextStatus === "complained"
      ? detail || `Resend reported ${eventType}`
      : null;

  await db
    .prepare(
      `UPDATE messages
       SET status = ?, delivery_events_json = ?, delivery_error = COALESCE(?, delivery_error), updated_at = ?
       WHERE id = ?`,
    )
    .bind(nextStatus, JSON.stringify(events), deliveryError, new Date().toISOString(), row.id)
    .run();

  return { updated: true, messageId: row.id, status: nextStatus };
}

export interface SendOrDraftInput {
  mode: "send" | "draft" | "pending_approval";
  fromAddressId?: string;
  fromAddress?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  textBody?: string;
  htmlBody?: string;
  threadId?: string;
  replyToMessageId?: string;
  forwardMessageId?: string;
  attachmentIds?: string[];
  extraHeaders?: Record<string, string>;
  trackOpensAndClicks?: boolean;
}

export interface ActorContext {
  actorLabel: string;
  agentKeyId?: string | null;
}

/**
 * Resolves the sender email and display name from explicit ID, explicit email, or system default.
 */
async function resolveSenderAddress(
  db: D1Database,
  input: { fromAddressId?: string; fromAddress?: string },
): Promise<{ email: string; displayName: string }> {
  if (input.fromAddressId) {
    const addr = await findAddressById(db, input.fromAddressId);
    if (!addr || !addr.isActive) {
      throw new Error("Configured sender address not found or inactive");
    }
    return { email: addr.email, displayName: addr.displayName };
  }

  if (input.fromAddress) {
    const configured = await findAddressByEmail(db, input.fromAddress);
    if (configured && configured.isActive) {
      return { email: configured.email, displayName: configured.displayName };
    }
    // Allow sending from any address on any configured domain when catch-all is enabled.
    const settings = await getSettings(db);
    const domain = input.fromAddress.split("@")[1]?.toLowerCase() ?? "";
    const configuredDomains = settings.mailDomains.length > 0
      ? settings.mailDomains
      : settings.mailDomain
        ? [settings.mailDomain]
        : [];
    if (settings.catchAllEnabled && domain && configuredDomains.includes(domain)) {
      return { email: input.fromAddress.toLowerCase(), displayName: "" };
    }
    throw new Error(`Sender address ${input.fromAddress} is not configured in Addresses`);
  }

  const def = await getDefaultAddress(db);
  if (!def) {
    const settings = await getSettings(db);
    if (settings.mailDomain) {
      return { email: `postmaster@${settings.mailDomain}`, displayName: "Postlet" };
    }
    throw new Error("No sender address configured. Add one in Settings -> Addresses.");
  }
  return { email: def.email, displayName: def.displayName };
}

/**
 * Creates a draft, queues a `pending_approval` message, or immediately sends an email via the
 * configured `MailTransport` (`resend`, `cloudflare`, or `ses`).
 */
export async function sendOrDraftEmail(
  db: D1Database,
  r2: R2Bucket,
  transport: MailTransport,
  input: SendOrDraftInput,
  actor: ActorContext,
  trackingConfig?: SelfHostedTrackingConfig,
): Promise<{ message: MessageRecord; threadId: string }> {
  const sender = await resolveSenderAddress(db, {
    fromAddressId: input.fromAddressId,
    fromAddress: input.fromAddress,
  });

  let threadId = input.threadId ?? null;
  let inReplyTo: string | null = null;
  let referencesHeader: string | null = null;
  let subject = input.subject.trim();

  // Inherit thread and RFC threading headers when replying.
  if (input.replyToMessageId) {
    const parent = await db
      .prepare(`SELECT thread_id, rfc_message_id, references_header, subject FROM messages WHERE id = ?`)
      .bind(input.replyToMessageId)
      .first<{
        thread_id: string;
        rfc_message_id: string | null;
        references_header: string | null;
        subject: string;
      }>();

    if (!parent) {
      throw new Error("Parent message for reply not found");
    }
    threadId = threadId ?? parent.thread_id;
    inReplyTo = parent.rfc_message_id;
    referencesHeader = [parent.references_header, parent.rfc_message_id]
      .filter(Boolean)
      .join(" ")
      .trim() || null;

    if (!/^re:/i.test(subject)) {
      subject = `Re: ${subject}`;
    }
  } else if (input.forwardMessageId && !threadId) {
    const source = await db
      .prepare(`SELECT thread_id FROM messages WHERE id = ?`)
      .bind(input.forwardMessageId)
      .first<{ thread_id: string }>();
    if (source) {
      threadId = source.thread_id;
    }
  }

  const now = new Date().toISOString();
  const messageId = crypto.randomUUID();
  const fromDomain = sender.email.split("@")[1] || "postlet.local";
  const rfcMessageId = `<${messageId}@${fromDomain}>`;
  const textBody = input.textBody ?? "";
  const htmlBody = input.htmlBody ?? "";
  const snippet = createSnippet(textBody, htmlBody);
  const toList = input.to.map((e) => e.toLowerCase());
  const ccList = (input.cc ?? []).map((e) => e.toLowerCase());
  const bccList = (input.bcc ?? []).map((e) => e.toLowerCase());
  const allParticipants = Array.from(new Set([sender.email, ...toList, ...ccList]));

  const isNewThread = !threadId;
  if (!threadId) {
    threadId = crypto.randomUUID();
  }

  const targetFolder =
    input.mode === "draft"
      ? "drafts"
      : input.mode === "pending_approval"
        ? "pending_approval"
        : "sent";

  if (isNewThread) {
    await db
      .prepare(
        `INSERT INTO threads
         (id, subject, snippet, participants_json, recipient_address, folder, last_message_at,
          message_count, unread_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      )
      .bind(
        threadId,
        subject,
        snippet,
        JSON.stringify(allParticipants),
        sender.email,
        targetFolder,
        now,
        now,
        now,
      )
      .run();
  } else {
    const existingThread = await db
      .prepare(`SELECT folder, participants_json FROM threads WHERE id = ?`)
      .bind(threadId)
      .first<{ folder: string; participants_json: string }>();

    if (!existingThread) {
      throw new Error("Target thread not found");
    }

    const mergedParticipants = Array.from(
      new Set([
        ...safeJsonParse<string[]>(existingThread.participants_json, []),
        ...allParticipants,
      ]),
    );
    // Keep active inbox threads visible in Inbox even when drafting/sending a reply inside them.
    const nextThreadFolder = existingThread.folder === "inbox" ? "inbox" : existingThread.folder;

    await db
      .prepare(
        `UPDATE threads
         SET snippet = ?,
             participants_json = ?,
             folder = ?,
             last_message_at = ?,
             message_count = message_count + 1,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(snippet, JSON.stringify(mergedParticipants), nextThreadFolder, now, now, threadId)
      .run();
  }

  const initialStatus: MessageStatus = input.mode === "send" ? "draft" : input.mode;
  const headersObj: Record<string, string> = {
    ...(input.extraHeaders ?? {}),
    "message-id": rfcMessageId,
    ...(inReplyTo ? { "in-reply-to": inReplyTo } : {}),
    ...(referencesHeader ? { references: referencesHeader } : {}),
    ...(input.trackOpensAndClicks ? { "x-postlet-track": "true" } : {}),
  };

  await db
    .prepare(
      `INSERT INTO messages
       (id, thread_id, resend_email_id, rfc_message_id, in_reply_to, references_header,
        direction, status, from_address, from_name, to_addresses_json, cc_addresses_json,
        bcc_addresses_json, reply_to, subject, text_body, html_body, headers_json,
        is_read, folder, created_by_agent_key_id, created_by_actor, delivery_events_json,
        created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, '[]', ?, ?)`,
    )
    .bind(
      messageId,
      threadId,
      rfcMessageId,
      inReplyTo,
      referencesHeader,
      initialStatus,
      sender.email,
      sender.displayName,
      JSON.stringify(toList),
      JSON.stringify(ccList),
      JSON.stringify(bccList),
      input.replyTo ?? null,
      subject,
      textBody,
      htmlBody,
      JSON.stringify(headersObj),
      targetFolder,
      actor.agentKeyId ?? null,
      actor.actorLabel,
      now,
      now,
    )
    .run();

  if (input.attachmentIds && input.attachmentIds.length > 0) {
    await claimPendingAttachments(db, input.attachmentIds, messageId);
  }

  if (input.mode === "send") {
    await dispatchMessageViaTransport(db, r2, transport, messageId, trackingConfig);
  }

  const detail = await getMessageById(db, messageId);
  if (!detail) {
    throw new Error("Failed to load stored message");
  }
  return { message: detail, threadId };
}

/**
 * Dispatches an existing draft or pending-approval message through the configured `MailTransport`
 * (`resend`, `cloudflare`, or `ses`) and records the provider message ID or failure.
 */
async function dispatchMessageViaTransport(
  db: D1Database,
  r2: R2Bucket,
  transport: MailTransport,
  messageId: string,
  trackingConfig?: SelfHostedTrackingConfig,
): Promise<void> {
  const row = await db
    .prepare(`SELECT * FROM messages WHERE id = ?`)
    .bind(messageId)
    .first<MessageRow>();
  if (!row) {
    throw new Error("Message not found");
  }

  const attachments = await loadAttachmentsForResend(db, r2, messageId);
  const safeFromName = stripCrlf(row.from_name);
  const formattedFrom = safeFromName ? `${safeFromName} <${row.from_address}>` : row.from_address;
  const parsedHeaders = safeJsonParse<Record<string, string>>(row.headers_json, {});
  const outboundHeaders: Record<string, string> = {};
  if (row.rfc_message_id) outboundHeaders["Message-ID"] = stripCrlf(row.rfc_message_id);
  if (row.in_reply_to) outboundHeaders["In-Reply-To"] = stripCrlf(row.in_reply_to);
  if (row.references_header) outboundHeaders["References"] = stripCrlf(row.references_header);
  if (parsedHeaders["auto-submitted"]) {
    outboundHeaders["Auto-Submitted"] = stripCrlf(parsedHeaders["auto-submitted"]);
  }

  let outboundHtml = row.html_body;
  if (parsedHeaders["x-postlet-track"] === "true") {
    if (trackingConfig?.baseUrl && trackingConfig?.secret) {
      outboundHtml = await instrumentHtmlWithSelfHostedTracking(row.html_body, row.text_body, {
        messageId,
        baseUrl: trackingConfig.baseUrl,
        secret: trackingConfig.secret,
      });
    } else if (!transport.provider || transport.provider === "resend") {
      const senderDomain = row.from_address.split("@")[1]?.trim() ?? "";
      if (senderDomain && !/[\s"<>]/.test(senderDomain)) {
        const trackingUrl = `https://${senderDomain}`;
        outboundHtml = appendHiddenResendTrackingLink(row.html_body, row.text_body, trackingUrl);
      }
    }
  }

  try {
    const sent = await transport.sendEmail({
      from: formattedFrom,
      to: safeJsonParse<string[]>(row.to_addresses_json, []),
      cc: safeJsonParse<string[]>(row.cc_addresses_json, []),
      bcc: safeJsonParse<string[]>(row.bcc_addresses_json, []),
      ...(row.reply_to ? { reply_to: stripCrlf(row.reply_to) } : {}),
      subject: stripCrlf(row.subject),
      ...(row.text_body ? { text: row.text_body } : {}),
      ...(outboundHtml ? { html: outboundHtml } : {}),
      ...(Object.keys(outboundHeaders).length > 0 ? { headers: outboundHeaders } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    });

    const now = new Date().toISOString();
    const events = safeJsonParse<DeliveryEvent[]>(row.delivery_events_json, []);
    const initialStatus = sent.initialStatus ?? "sent";
    events.push({
      type: initialStatus === "delivered" ? "email.delivered" : initialStatus === "bounced" ? "email.bounced" : "email.sent",
      timestamp: now,
      ...(sent.deliveryError ? { detail: sent.deliveryError } : {}),
    });

    await db
      .prepare(
        `UPDATE messages
         SET resend_email_id = ?, status = ?, folder = 'sent', delivery_error = ?,
             delivery_events_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        sent.id,
        initialStatus,
        sent.deliveryError ?? null,
        JSON.stringify(events),
        now,
        messageId,
      )
      .run();

    // If the thread was sitting in drafts or pending_approval as a standalone compose, move it to sent.
    await db
      .prepare(
        `UPDATE threads SET folder = 'sent', updated_at = ? WHERE id = ? AND folder IN ('drafts', 'pending_approval')`,
      )
      .bind(now, row.thread_id)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to send email";
    await db
      .prepare(`UPDATE messages SET status = 'failed', delivery_error = ?, updated_at = ? WHERE id = ?`)
      .bind(msg, new Date().toISOString(), messageId)
      .run();
    throw err;
  }
}

/**
 * Approves a `pending_approval` message (optionally applying owner edits) and sends it via the
 * configured `MailTransport`.
 */
export async function approvePendingMessage(
  db: D1Database,
  r2: R2Bucket,
  transport: MailTransport,
  messageId: string,
  edits?: {
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    textBody?: string;
    htmlBody?: string;
  },
  trackingConfig?: SelfHostedTrackingConfig,
): Promise<MessageRecord> {
  const existing = await db
    .prepare(`SELECT * FROM messages WHERE id = ?`)
    .bind(messageId)
    .first<MessageRow>();

  if (!existing) {
    throw new Error("Pending message not found");
  }
  if (existing.status !== "pending_approval" && existing.status !== "draft") {
    throw new Error(`Message status '${existing.status}' cannot be approved`);
  }

  if (edits) {
    const now = new Date().toISOString();
    const nextSubject = edits.subject ?? existing.subject;
    const nextText = edits.textBody ?? existing.text_body;
    const nextHtml = edits.htmlBody ?? existing.html_body;
    await db
      .prepare(
        `UPDATE messages
         SET to_addresses_json = ?, cc_addresses_json = ?, bcc_addresses_json = ?,
             subject = ?, text_body = ?, html_body = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        edits.to ? JSON.stringify(edits.to) : existing.to_addresses_json,
        edits.cc ? JSON.stringify(edits.cc) : existing.cc_addresses_json,
        edits.bcc ? JSON.stringify(edits.bcc) : existing.bcc_addresses_json,
        nextSubject,
        nextText,
        nextHtml,
        now,
        messageId,
      )
      .run();
  }

  await dispatchMessageViaTransport(db, r2, transport, messageId, trackingConfig);
  const updated = await getMessageById(db, messageId);
  if (!updated) {
    throw new Error("Message disappeared after approval");
  }
  return updated;
}

/**
 * Rejects a `pending_approval` message so it is never sent.
 */
export async function rejectPendingMessage(db: D1Database, messageId: string): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE messages SET status = 'rejected', folder = 'trash', updated_at = ?
       WHERE id = ? AND status = 'pending_approval'`,
    )
    .bind(new Date().toISOString(), messageId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export interface UpdateDraftInput {
  mode: "draft" | "send";
  fromAddressId?: string;
  fromAddress?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  textBody?: string;
  htmlBody?: string;
  attachmentIds?: string[];
  trackOpensAndClicks?: boolean;
}

/**
 * Updates an existing saved draft (or unsent failed outbound message) in place, syncs R2
 * attachments, updates parent thread metadata, and optionally dispatches it immediately via Resend.
 */
export async function updateDraftMessage(
  db: D1Database,
  r2: R2Bucket,
  transport: MailTransport,
  messageId: string,
  input: UpdateDraftInput,
  trackingConfig?: SelfHostedTrackingConfig,
): Promise<{ message: MessageRecord; threadId: string }> {
  const existing = await db
    .prepare(`SELECT * FROM messages WHERE id = ?`)
    .bind(messageId)
    .first<MessageRow>();

  if (!existing) {
    throw new Error("Draft message not found");
  }

  const isEditable =
    existing.status === "draft" ||
    (existing.status === "failed" && existing.resend_email_id === null);
  if (!isEditable) {
    throw new Error(
      `Only draft or unsent failed messages can be edited (current status: '${existing.status}')`,
    );
  }

  const sender = await resolveSenderAddress(db, {
    fromAddressId: input.fromAddressId,
    fromAddress: input.fromAddress ?? existing.from_address,
  });

  const toList = input.to.map((e) => e.toLowerCase());
  const ccList = (input.cc ?? []).map((e) => e.toLowerCase());
  const bccList = (input.bcc ?? []).map((e) => e.toLowerCase());
  const subject = input.subject.trim();
  const textBody = input.textBody ?? "";
  const htmlBody = input.htmlBody ?? "";
  const snippet = createSnippet(textBody, htmlBody);
  const now = new Date().toISOString();

  const updatedHeaders = safeJsonParse<Record<string, string>>(existing.headers_json, {});
  if (input.trackOpensAndClicks !== undefined) {
    if (input.trackOpensAndClicks) {
      updatedHeaders["x-postlet-track"] = "true";
    } else {
      delete updatedHeaders["x-postlet-track"];
    }
  }

  await db
    .prepare(
      `UPDATE messages
       SET from_address = ?,
           from_name = ?,
           to_addresses_json = ?,
           cc_addresses_json = ?,
           bcc_addresses_json = ?,
           reply_to = ?,
           subject = ?,
           text_body = ?,
           html_body = ?,
           headers_json = ?,
           status = 'draft',
           folder = 'drafts',
           delivery_error = NULL,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      sender.email,
      sender.displayName,
      JSON.stringify(toList),
      JSON.stringify(ccList),
      JSON.stringify(bccList),
      input.replyTo !== undefined ? input.replyTo : existing.reply_to,
      subject,
      textBody,
      htmlBody,
      JSON.stringify(updatedHeaders),
      now,
      messageId,
    )
    .run();

  if (input.attachmentIds !== undefined) {
    await syncDraftAttachments(db, r2, messageId, input.attachmentIds);
  }

  const thread = await db
    .prepare(`SELECT folder, participants_json FROM threads WHERE id = ?`)
    .bind(existing.thread_id)
    .first<{ folder: string; participants_json: string }>();

  if (thread) {
    const countRow = await db
      .prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE thread_id = ?`)
      .bind(existing.thread_id)
      .first<{ cnt: number }>();
    const msgCount = Number(countRow?.cnt ?? 0);

    const mergedParticipants = Array.from(
      new Set([
        ...safeJsonParse<string[]>(thread.participants_json, []),
        sender.email,
        ...toList,
        ...ccList,
      ]),
    );

    if (msgCount <= 1 || thread.folder === "drafts") {
      await db
        .prepare(
          `UPDATE threads
           SET subject = ?,
               snippet = ?,
               participants_json = ?,
               recipient_address = ?,
               last_message_at = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          subject,
          snippet,
          JSON.stringify(mergedParticipants),
          sender.email,
          now,
          now,
          existing.thread_id,
        )
        .run();
    } else {
      await db
        .prepare(
          `UPDATE threads
           SET snippet = ?,
               participants_json = ?,
               last_message_at = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .bind(snippet, JSON.stringify(mergedParticipants), now, now, existing.thread_id)
        .run();
    }
  }

  if (input.mode === "send") {
    await dispatchMessageViaTransport(db, r2, transport, messageId, trackingConfig);
  }

  const updated = await getMessageById(db, messageId);
  if (!updated) {
    throw new Error("Draft message disappeared after update");
  }
  return { message: updated, threadId: existing.thread_id };
}

/**
 * Permanently discards a draft (or unsent failed message) along with its R2 attachments,
 * removing the parent thread if no other messages remain in it.
 */
export async function deleteDraftMessage(
  db: D1Database,
  r2: R2Bucket,
  messageId: string,
): Promise<{ deleted: boolean; threadDeleted: boolean }> {
  const existing = await db
    .prepare(`SELECT * FROM messages WHERE id = ?`)
    .bind(messageId)
    .first<MessageRow>();

  if (!existing) {
    return { deleted: false, threadDeleted: false };
  }

  const isDiscardable =
    existing.status === "draft" ||
    (existing.status === "failed" && existing.resend_email_id === null);
  if (!isDiscardable) {
    throw new Error("Only draft or unsent failed messages can be discarded");
  }

  await deleteAttachmentsForMessage(db, r2, messageId);
  await db.prepare(`DELETE FROM messages WHERE id = ?`).bind(messageId).run();

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE thread_id = ?`)
    .bind(existing.thread_id)
    .first<{ cnt: number }>();
  const remainingCount = Number(countRow?.cnt ?? 0);

  if (remainingCount === 0) {
    await db.prepare(`DELETE FROM threads WHERE id = ?`).bind(existing.thread_id).run();
    return { deleted: true, threadDeleted: true };
  }

  const latestRemaining = await db
    .prepare(
      `SELECT text_body, html_body, created_at FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(existing.thread_id)
    .first<{ text_body: string; html_body: string; created_at: string }>();

  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE threads
       SET message_count = ?,
           snippet = ?,
           last_message_at = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      remainingCount,
      latestRemaining ? createSnippet(latestRemaining.text_body, latestRemaining.html_body) : "",
      latestRemaining?.created_at ?? now,
      now,
      existing.thread_id,
    )
    .run();

  return { deleted: true, threadDeleted: false };
}

/**
 * Loads a single message record with its attachments.
 */
export async function getMessageById(
  db: D1Database,
  messageId: string,
): Promise<MessageRecord | null> {
  const row = await db
    .prepare(`SELECT * FROM messages WHERE id = ?`)
    .bind(messageId)
    .first<MessageRow>();
  if (!row) return null;
  const attachmentMap = await listAttachmentsByMessageIds(db, [row.id]);
  return mapMessageRow(row, attachmentMap.get(row.id) ?? []);
}

/**
 * Persists a per-message preference allowing or blocking remote external images in HTML bodies
 * (`x-postlet-allow-images` in `headers_json`), so reopening the thread preserves the choice.
 */
export async function setMessageAllowRemoteImages(
  db: D1Database,
  messageId: string,
  allow: boolean,
): Promise<MessageRecord | null> {
  const row = await db
    .prepare(`SELECT id, headers_json FROM messages WHERE id = ?`)
    .bind(messageId)
    .first<{ id: string; headers_json: string }>();

  if (!row) {
    return null;
  }

  const headers = safeJsonParse<Record<string, string>>(row.headers_json, {});
  if (allow) {
    headers["x-postlet-allow-images"] = "true";
  } else {
    delete headers["x-postlet-allow-images"];
  }

  const now = new Date().toISOString();
  await db
    .prepare(`UPDATE messages SET headers_json = ?, updated_at = ? WHERE id = ?`)
    .bind(JSON.stringify(headers), now, messageId)
    .run();

  return getMessageById(db, messageId);
}

export interface ListThreadsQuery {
  folder?: FolderName;
  address?: string;
  domain?: string;
  unreadOnly?: boolean;
  priority?: AiPriority;
  category?: AiCategory;
  q?: string;
  limit?: number;
  offset?: number;
  /** Enforces strict address isolation for alias-scoped agent API keys. */
  scopedAddressEmail?: string | null;
}

/**
 * Lists conversation threads matching folder, address, domain, AI triage, or FTS5 search filters.
 */
export async function listThreads(
  db: D1Database,
  query: ListThreadsQuery,
): Promise<ThreadSummary[]> {
  const clauses: string[] = [];
  const bindings: unknown[] = [];

  if (query.scopedAddressEmail) {
    clauses.push(`lower(t.recipient_address) = ?`);
    bindings.push(query.scopedAddressEmail.toLowerCase());
  } else if (query.address) {
    clauses.push(`lower(t.recipient_address) = ?`);
    bindings.push(query.address.toLowerCase());
  } else if (query.domain) {
    const cleanDomain = query.domain.trim().replace(/^@+/, "").toLowerCase();
    if (cleanDomain) {
      clauses.push(
        `instr(t.recipient_address, '@') > 0 AND lower(substr(t.recipient_address, instr(t.recipient_address, '@') + 1)) = ?`,
      );
      bindings.push(cleanDomain);
    }
  }

  if (query.folder) {
    if (query.folder === "pending_approval") {
      clauses.push(
        `EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.status = 'pending_approval')`,
      );
    } else if (query.folder === "sent") {
      clauses.push(
        `(t.folder = 'sent' OR EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.direction = 'outbound' AND m.status IN ('sent','delivered','delayed','bounced','complained','failed')))`,
      );
    } else if (query.folder === "drafts") {
      clauses.push(
        `(t.folder = 'drafts' OR EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.status = 'draft'))`,
      );
    } else {
      clauses.push(`t.folder = ?`);
      bindings.push(query.folder);
    }
  }

  if (query.unreadOnly) {
    clauses.push(`t.unread_count > 0`);
  }
  if (query.priority) {
    clauses.push(`t.ai_priority = ?`);
    bindings.push(query.priority);
  }
  if (query.category) {
    clauses.push(`t.ai_category = ?`);
    bindings.push(query.category);
  }

  if (query.q && query.q.trim().length > 0) {
    const safeTokens = query.q
      .trim()
      .slice(0, 200)
      .replace(/["'*:^{}()]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 10)
      .map((tok) => `"${tok}"*`)
      .join(" ");
    if (safeTokens) {
      clauses.push(
        `t.id IN (SELECT thread_id FROM messages_fts WHERE messages_fts MATCH ?)`,
      );
      bindings.push(safeTokens);
    }
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);

  const { results } = await db
    .prepare(
      `SELECT t.*,
              (SELECT m.status FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS latest_status,
              (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.status = 'pending_approval') AS pending_count
       FROM threads t
       ${whereSql}
       ORDER BY t.last_message_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, limit, offset)
    .all<ThreadRow>();

  return (results ?? []).map(mapThreadRow);
}

/**
 * Fetches full thread metadata, ordered messages, and R2 attachment descriptors.
 * Enforces `scopedAddressEmail` when called on behalf of an alias-locked agent key.
 */
export async function getThreadDetail(
  db: D1Database,
  threadId: string,
  scopedAddressEmail?: string | null,
): Promise<ThreadDetail | null> {
  const row = await db
    .prepare(
      `SELECT t.*,
              (SELECT m.status FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS latest_status,
              (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.status = 'pending_approval') AS pending_count
       FROM threads t
       WHERE t.id = ?`,
    )
    .bind(threadId)
    .first<ThreadRow>();

  if (!row) return null;

  if (
    scopedAddressEmail &&
    row.recipient_address.toLowerCase() !== scopedAddressEmail.toLowerCase()
  ) {
    return null;
  }

  const { results: messageRows } = await db
    .prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC`)
    .bind(threadId)
    .all<MessageRow>();

  const rows = messageRows ?? [];
  const attachmentsMap = await listAttachmentsByMessageIds(
    db,
    rows.map((m) => m.id),
  );

  return {
    ...mapThreadRow(row),
    messages: rows.map((m) => mapMessageRow(m, attachmentsMap.get(m.id) ?? [])),
  };
}

/**
 * Updates thread folder (`inbox`, `archive`, `trash`) or read/unread state.
 */
export async function updateThread(
  db: D1Database,
  threadId: string,
  patch: { folder?: "inbox" | "archive" | "trash"; isRead?: boolean },
): Promise<ThreadSummary | null> {
  const existing = await db
    .prepare(`SELECT id, folder, unread_count FROM threads WHERE id = ?`)
    .bind(threadId)
    .first<{ id: string; folder: string; unread_count: number }>();

  if (!existing) return null;

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];

  if (patch.folder !== undefined) {
    statements.push(
      db
        .prepare(`UPDATE threads SET folder = ?, updated_at = ? WHERE id = ?`)
        .bind(patch.folder, now, threadId),
    );
  }

  if (patch.isRead !== undefined) {
    const readVal = patch.isRead ? 1 : 0;
    statements.push(
      db
        .prepare(`UPDATE messages SET is_read = ?, updated_at = ? WHERE thread_id = ?`)
        .bind(readVal, now, threadId),
    );
    if (patch.isRead) {
      statements.push(
        db
          .prepare(`UPDATE threads SET unread_count = 0, updated_at = ? WHERE id = ?`)
          .bind(now, threadId),
      );
    } else {
      statements.push(
        db
          .prepare(
            `UPDATE threads
             SET unread_count = (SELECT COUNT(*) FROM messages WHERE thread_id = ? AND is_read = 0),
                 updated_at = ?
             WHERE id = ?`,
          )
          .bind(threadId, now, threadId),
      );
    }
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }

  const refreshed = await db
    .prepare(
      `SELECT t.*,
              (SELECT m.status FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS latest_status,
              (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.status = 'pending_approval') AS pending_count
       FROM threads t WHERE t.id = ?`,
    )
    .bind(threadId)
    .first<ThreadRow>();
  return refreshed ? mapThreadRow(refreshed) : null;
}

/**
 * Permanently deletes a thread, its messages, and its R2 attachment objects.
 */
export async function deleteThreadPermanently(
  db: D1Database,
  r2: R2Bucket,
  threadId: string,
): Promise<boolean> {
  const { results: attachmentRows } = await db
    .prepare(
      `SELECT a.r2_key FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE m.thread_id = ?`,
    )
    .bind(threadId)
    .all<{ r2_key: string }>();

  for (const row of attachmentRows ?? []) {
    await r2.delete(row.r2_key);
  }

  const res = await db.prepare(`DELETE FROM threads WHERE id = ?`).bind(threadId).run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Computes all sidebar folder and badge counts in minimal D1 queries for Free-Tier efficiency.
 */
export async function getFolderCounts(db: D1Database): Promise<FolderCounts> {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN folder = 'inbox' AND unread_count > 0 THEN 1 ELSE 0 END) AS inboxUnread,
         SUM(CASE WHEN folder = 'inbox' THEN 1 ELSE 0 END) AS inboxTotal,
         SUM(CASE WHEN folder = 'archive' THEN 1 ELSE 0 END) AS archive,
         SUM(CASE WHEN folder = 'trash' THEN 1 ELSE 0 END) AS trash
       FROM threads`,
    )
    .first<{
      inboxUnread: number | null;
      inboxTotal: number | null;
      archive: number | null;
      trash: number | null;
    }>();

  const msgCounts = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending_approval' THEN 1 ELSE 0 END) AS pendingApproval,
         SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts,
         COUNT(DISTINCT CASE WHEN direction = 'outbound' AND status IN ('sent','delivered','delayed','bounced','complained','failed') THEN thread_id END) AS sent
       FROM messages`,
    )
    .first<{
      pendingApproval: number | null;
      drafts: number | null;
      sent: number | null;
    }>();

  return {
    inboxUnread: row?.inboxUnread ?? 0,
    inboxTotal: row?.inboxTotal ?? 0,
    pendingApproval: msgCounts?.pendingApproval ?? 0,
    drafts: msgCounts?.drafts ?? 0,
    sent: msgCounts?.sent ?? 0,
    archive: row?.archive ?? 0,
    trash: row?.trash ?? 0,
  };
}

/**
 * Computes unread Inbox thread counts grouped by recipient domain for multi-domain sidebar badges.
 */
export async function getDomainUnreadCounts(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT lower(substr(recipient_address, instr(recipient_address, '@') + 1)) AS domain,
              SUM(CASE WHEN unread_count > 0 THEN 1 ELSE 0 END) AS unread_threads
       FROM threads
       WHERE folder = 'inbox' AND unread_count > 0 AND instr(recipient_address, '@') > 0
       GROUP BY domain`,
    )
    .all<{ domain: string; unread_threads: number }>();

  const counts: Record<string, number> = {};
  for (const row of results ?? []) {
    if (row.domain) {
      counts[row.domain] = Number(row.unread_threads ?? 0);
    }
  }
  return counts;
}
