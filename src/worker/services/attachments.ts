/**
 * @file src/worker/services/attachments.ts
 * @description Manages binary email attachments in Cloudflare R2 and metadata in D1,
 * streaming uploads/downloads to respect Worker memory bounds and setting immutable
 * cache headers to minimize R2 Class B operations on the Free Tier.
 */

import type { AttachmentRecord } from "../../shared/types";
import { bytesToBase64 } from "../lib/crypto";
import type {
  ResendAttachmentInput,
  ResendClient,
  ResendWebhookAttachmentMeta,
} from "./resend";

const MAX_OUTBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB Resend payload limit
const MAX_INBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB inbound safety bound

/** Strict raster image MIME allowlist safe for inline browser display (excludes image/svg+xml). */
const SAFE_INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

interface AttachmentRow {
  id: string;
  message_id: string | null;
  resend_attachment_id: string | null;
  r2_key: string;
  filename: string;
  content_type: string;
  content_disposition: string;
  content_id: string | null;
  size_bytes: number;
  created_at: string;
}

export function mapAttachmentRow(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    messageId: row.message_id,
    resendAttachmentId: row.resend_attachment_id,
    r2Key: row.r2_key,
    filename: row.filename,
    contentType: row.content_type,
    contentDisposition: row.content_disposition,
    contentId: row.content_id,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}

/**
 * Sanitizes a user/sender filename so R2 object keys and Content-Disposition headers stay safe.
 * Strips ASCII control characters (`\x00-\x1f`, `\x7f`) and path/quote punctuation.
 */
function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 180) : "attachment.bin";
}

/**
 * Stores an uploaded attachment stream or byte buffer in R2 and inserts its metadata in D1.
 *
 * @param db D1 database binding.
 * @param r2 R2 bucket binding.
 * @param params Upload payload and metadata.
 * @returns Stored AttachmentRecord.
 */
export async function storeAttachment(
  db: D1Database,
  r2: R2Bucket,
  params: {
    messageId: string | null;
    filename: string;
    contentType: string;
    sizeBytes: number;
    body: ReadableStream | ArrayBuffer | Uint8Array;
    contentDisposition?: string;
    contentId?: string | null;
    resendAttachmentId?: string | null;
  },
): Promise<AttachmentRecord> {
  const id = crypto.randomUUID();
  const safeName = sanitizeFilename(params.filename);
  const r2Key = `attachments/${params.messageId ?? "staged"}/${id}/${safeName}`;
  const now = new Date().toISOString();
  const disposition = params.contentDisposition || "attachment";

  await r2.put(r2Key, params.body, {
    httpMetadata: {
      contentType: params.contentType || "application/octet-stream",
    },
  });

  await db
    .prepare(
      `INSERT INTO attachments
       (id, message_id, resend_attachment_id, r2_key, filename, content_type, content_disposition, content_id, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      params.messageId ?? null,
      params.resendAttachmentId ?? null,
      r2Key,
      safeName,
      params.contentType || "application/octet-stream",
      disposition,
      params.contentId ?? null,
      params.sizeBytes,
      now,
    )
    .run();

  return {
    id,
    messageId: params.messageId ?? null,
    resendAttachmentId: params.resendAttachmentId ?? null,
    r2Key,
    filename: safeName,
    contentType: params.contentType || "application/octet-stream",
    contentDisposition: disposition,
    contentId: params.contentId ?? null,
    sizeBytes: params.sizeBytes,
    createdAt: now,
  };
}

/**
 * Fetches inbound attachment binaries from Resend's Receiving Attachments API and streams
 * them straight into Cloudflare R2.
 *
 * @param db D1 database binding.
 * @param r2 R2 bucket binding.
 * @param resendClient Typed Resend client.
 * @param messageId Local Postlet message ID.
 * @param resendEmailId Resend inbound email ID.
 * @param webhookAttachments Attachment descriptors from webhook or receiving metadata.
 */
export async function ingestResendAttachments(
  db: D1Database,
  r2: R2Bucket,
  resendClient: ResendClient,
  messageId: string,
  resendEmailId: string,
  webhookAttachments: ResendWebhookAttachmentMeta[],
): Promise<AttachmentRecord[]> {
  if (!webhookAttachments || webhookAttachments.length === 0) {
    return [];
  }

  // Prefer listing all attachment download URLs in a single API call to minimize subrequests.
  let detailById = new Map<string, { download_url: string; size?: number }>();
  try {
    const listed = await resendClient.listReceivedAttachments(resendEmailId);
    for (const item of listed) {
      if (item.download_url) {
        detailById.set(item.id, { download_url: item.download_url, size: item.size });
      }
    }
  } catch {
    // Fallback to per-attachment lookup below if list endpoint fails or returns partial data.
  }

  const stored: AttachmentRecord[] = [];
  for (const meta of webhookAttachments) {
    if (typeof meta.size === "number" && meta.size > MAX_INBOUND_ATTACHMENT_BYTES) {
      throw new Error("Inbound attachment exceeds 25 MB safety limit");
    }

    let downloadInfo = detailById.get(meta.id);
    if (!downloadInfo) {
      const single = await resendClient.getReceivedAttachment(resendEmailId, meta.id);
      downloadInfo = { download_url: single.download_url, size: single.size };
    }
    if (typeof downloadInfo.size === "number" && downloadInfo.size > MAX_INBOUND_ATTACHMENT_BYTES) {
      throw new Error("Inbound attachment exceeds 25 MB safety limit");
    }

    const downloadRes = await resendClient.fetchDownloadStream(downloadInfo.download_url);
    const contentLengthHeader = downloadRes.headers.get("content-length");
    const parsedLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : NaN;
    if (Number.isFinite(parsedLength) && parsedLength > MAX_INBOUND_ATTACHMENT_BYTES) {
      await downloadRes.body?.cancel();
      throw new Error("Inbound attachment Content-Length exceeds 25 MB safety limit");
    }

    // Stream directly when Content-Length is known and bounded; otherwise read chunks up to max cap.
    let body: ReadableStream | ArrayBuffer | Uint8Array;
    let sizeBytes = meta.size ?? downloadInfo.size ?? 0;

    if (downloadRes.body && Number.isFinite(parsedLength) && parsedLength >= 0) {
      body = downloadRes.body;
      sizeBytes = sizeBytes || parsedLength;
    } else if (downloadRes.body) {
      const bounded = await readStreamWithLimit(downloadRes.body, MAX_INBOUND_ATTACHMENT_BYTES);
      body = bounded;
      sizeBytes = bounded.byteLength;
    } else {
      const buf = await downloadRes.arrayBuffer();
      if (buf.byteLength > MAX_INBOUND_ATTACHMENT_BYTES) {
        throw new Error("Inbound attachment exceeds 25 MB safety limit");
      }
      body = buf;
      sizeBytes = buf.byteLength;
    }

    const record = await storeAttachment(db, r2, {
      messageId,
      filename: meta.filename || "attachment.bin",
      contentType: meta.content_type || "application/octet-stream",
      sizeBytes,
      body,
      contentDisposition: meta.content_disposition || "attachment",
      contentId: meta.content_id ?? null,
      resendAttachmentId: meta.id,
    });
    stored.push(record);
  }

  return stored;
}

/**
 * Reads an unbounded stream into a Uint8Array while aborting immediately if total bytes exceed `maxBytes`.
 */
async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Inbound attachment stream exceeds 25 MB safety limit");
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/**
 * Links pre-uploaded draft attachment records (staged under a temporary upload message ID or draft)
 * onto a newly created outbound message, or copies attachment references cleanly.
 *
 * @param db D1 database binding.
 * @param attachmentIds Attachment IDs created via `POST /api/admin/attachments`.
 * @param targetMessageId Target message ID to assign ownership to.
 */
export async function claimPendingAttachments(
  db: D1Database,
  attachmentIds: string[],
  targetMessageId: string,
): Promise<void> {
  if (attachmentIds.length === 0) return;
  const stmt = db.prepare(
    `UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL`,
  );
  await db.batch(attachmentIds.map((id) => stmt.bind(targetMessageId, id)));
}

/**
 * Fetches attachment metadata rows for a list of message IDs in a single D1 query.
 */
export async function listAttachmentsByMessageIds(
  db: D1Database,
  messageIds: string[],
): Promise<Map<string, AttachmentRecord[]>> {
  const result = new Map<string, AttachmentRecord[]>();
  if (messageIds.length === 0) return result;

  const placeholders = messageIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT id, message_id, resend_attachment_id, r2_key, filename, content_type,
              content_disposition, content_id, size_bytes, created_at
       FROM attachments
       WHERE message_id IN (${placeholders})
       ORDER BY created_at ASC`,
    )
    .bind(...messageIds)
    .all<AttachmentRow>();

  for (const row of results ?? []) {
    const mapped = mapAttachmentRow(row);
    if (!mapped.messageId) continue;
    const list = result.get(mapped.messageId) ?? [];
    list.push(mapped);
    result.set(mapped.messageId, list);
  }
  return result;
}

/**
 * Streams an attachment from Cloudflare R2 for authenticated download.
 * Sets long-lived private immutable cache headers to minimize repeat R2 Class B reads.
 *
 * @param db D1 database binding.
 * @param r2 R2 bucket binding.
 * @param attachmentId Attachment UUID.
 * @param inline Whether to request inline disposition (defaults to attachment for safety).
 * @returns HTTP Response or null if not found.
 */
export async function getAttachmentResponse(
  db: D1Database,
  r2: R2Bucket,
  attachmentId: string,
  inline = false,
): Promise<Response | null> {
  const row = await db
    .prepare(
      `SELECT id, message_id, resend_attachment_id, r2_key, filename, content_type,
              content_disposition, content_id, size_bytes, created_at
       FROM attachments WHERE id = ?`,
    )
    .bind(attachmentId)
    .first<AttachmentRow>();

  if (!row) {
    return null;
  }

  const object = await r2.get(row.r2_key);
  if (!object) {
    return null;
  }

  const headers = new Headers();
  const normalizedMime = (row.content_type || "application/octet-stream")
    .split(";")[0]
    .trim()
    .toLowerCase();
  headers.set("Content-Type", row.content_type || "application/octet-stream");
  // Strictly restrict inline rendering to safe raster images; SVG and other active formats force download.
  const dispositionType =
    inline && SAFE_INLINE_IMAGE_TYPES.has(normalizedMime) ? "inline" : "attachment";
  headers.set("Content-Disposition", `${dispositionType}; filename="${sanitizeFilename(row.filename)}"`);
  headers.set("Cache-Control", "private, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  if (typeof object.size === "number") {
    headers.set("Content-Length", String(object.size));
  }

  return new Response(object.body, { status: 200, headers });
}

/**
 * Loads attachments for an outbound message from R2 and encodes them for Resend's Send API.
 * Enforces the 25 MB total outbound attachment budget.
 */
export async function loadAttachmentsForResend(
  db: D1Database,
  r2: R2Bucket,
  messageId: string,
): Promise<ResendAttachmentInput[]> {
  const map = await listAttachmentsByMessageIds(db, [messageId]);
  const records = map.get(messageId) ?? [];
  if (records.length === 0) return [];

  let totalBytes = 0;
  const output: ResendAttachmentInput[] = [];

  for (const record of records) {
    const obj = await r2.get(record.r2Key);
    if (!obj) {
      throw new Error(`Attachment object missing from R2: ${record.filename}`);
    }
    const buf = await obj.arrayBuffer();
    totalBytes += buf.byteLength;
    if (totalBytes > MAX_OUTBOUND_ATTACHMENT_BYTES) {
      throw new Error("Total attachment size exceeds 25 MB limit");
    }
    output.push({
      filename: record.filename,
      content: bytesToBase64(new Uint8Array(buf)),
      content_type: record.contentType,
    });
  }

  return output;
}
