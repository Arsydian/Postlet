/**
 * @file src/worker/services/resend.ts
 * @description Typed Resend REST API client (outbound sending & inbound receiving/attachments)
 * plus Web Crypto Svix HMAC-SHA256 webhook signature verification.
 */

import { base64ToBytes, bytesToBase64, timingSafeEqualStrings } from "../lib/crypto";
import type { MailTransport } from "./transports/types";

export interface ResendAttachmentInput {
  filename: string;
  content: string; // Base64-encoded content
  content_type?: string;
}

export interface ResendSendEmailInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: ResendAttachmentInput[];
}

export interface ResendSendEmailResponse {
  id: string;
}

export interface ResendReceivedEmail {
  id: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string[];
  subject: string;
  text?: string | null;
  html?: string | null;
  headers?: Record<string, string>;
  message_id?: string;
  created_at?: string;
  attachments?: ResendWebhookAttachmentMeta[];
}

export interface ResendWebhookAttachmentMeta {
  id: string;
  filename: string;
  content_type: string;
  content_disposition?: string;
  content_id?: string;
  size?: number;
}

export interface ResendReceivedAttachmentDetail {
  id: string;
  filename: string;
  content_type: string;
  content_disposition?: string;
  content_id?: string;
  size?: number;
  download_url: string;
  expires_at?: string;
}

const SVIX_REPLAY_TOLERANCE_SECONDS = 300;
const textEncoder = new TextEncoder();

/**
 * Verifies a Resend webhook signature (Svix format) using Web Crypto HMAC-SHA256 and
 * constant-time comparison.
 *
 * @param rawBody Exact unmodified request body string.
 * @param headers Incoming HTTP request headers.
 * @param webhookSecret Resend signing secret (typically starts with `whsec_`).
 * @param nowSeconds Optional clock override for deterministic replay testing.
 * @returns True if timestamp is within ±5 minutes and at least one `v1` signature matches.
 */
export async function verifyResendWebhookSignature(
  rawBody: string,
  headers: Headers,
  webhookSecret: string,
  nowSeconds?: number,
): Promise<boolean> {
  if (!webhookSecret || !webhookSecret.trim()) {
    return false;
  }

  const svixId = headers.get("svix-id")?.trim();
  const svixTimestamp = headers.get("svix-timestamp")?.trim();
  const svixSignature = headers.get("svix-signature")?.trim();
  if (!svixId || !svixTimestamp || !svixSignature) {
    return false;
  }

  const timestampSec = Number.parseInt(svixTimestamp, 10);
  if (!Number.isFinite(timestampSec)) {
    return false;
  }

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampSec) > SVIX_REPLAY_TOLERANCE_SECONDS) {
    return false;
  }

  const secretRaw = webhookSecret.trim().startsWith("whsec_")
    ? webhookSecret.trim().slice("whsec_".length)
    : webhookSecret.trim();

  let secretBytes: Uint8Array<ArrayBuffer>;
  try {
    secretBytes = base64ToBytes(secretRaw);
  } catch {
    return false;
  }

  const hmacKey = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    textEncoder.encode(signedContent),
  );
  const expectedSignature = bytesToBase64(new Uint8Array(signatureBuffer));

  // Svix supports space-separated signature tokens (e.g., "v1,<b64> v1,<oldKeyB64>").
  const candidates = svixSignature.split(/\s+/).filter(Boolean);
  for (const token of candidates) {
    const commaIdx = token.indexOf(",");
    if (commaIdx <= 0) continue;
    const version = token.slice(0, commaIdx);
    const sig = token.slice(commaIdx + 1);
    if (version !== "v1" || !sig) continue;
    if (await timingSafeEqualStrings(sig, expectedSignature)) {
      return true;
    }
  }

  return false;
}

/**
 * Lightweight, Cloudflare Workers-native client for the Resend REST API.
 */
export class ResendClient implements MailTransport {
  readonly provider = "resend" as const;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(apiKey: string, fetchFn?: typeof fetch, baseUrl = "https://api.resend.com") {
    this.apiKey = apiKey;
    // Wrap native `fetch` in an arrow function calling `globalThis.fetch` directly.
    // Assigning bare `fetch` to `this.fetchFn` and calling `this.fetchFn(...)` binds
    // `this` to the ResendClient instance, throwing `Illegal invocation` in Cloudflare Workers.
    this.fetchFn =
      !fetchFn || fetchFn === globalThis.fetch
        ? (input, init) => globalThis.fetch(input, init)
        : (input, init) => fetchFn(input, init);
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.apiKey) {
      throw new Error("RESEND_API_KEY is not configured");
    }

    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Resend API ${res.status}: ${errorText}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Sends an email via `POST /emails`.
   */
  async sendEmail(input: ResendSendEmailInput): Promise<ResendSendEmailResponse> {
    return this.requestJson<ResendSendEmailResponse>("/emails", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /**
   * Fetches full inbound email body and headers via `GET /emails/receiving/:id`.
   */
  async getReceivedEmail(emailId: string): Promise<ResendReceivedEmail> {
    return this.requestJson<ResendReceivedEmail>(
      `/emails/receiving/${encodeURIComponent(emailId)}`,
      { method: "GET" },
    );
  }

  /**
   * Lists inbound attachment metadata and temporary download URLs for an email.
   */
  async listReceivedAttachments(emailId: string): Promise<ResendReceivedAttachmentDetail[]> {
    const raw = await this.requestJson<
      { data?: ResendReceivedAttachmentDetail[] } | ResendReceivedAttachmentDetail[]
    >(`/emails/receiving/${encodeURIComponent(emailId)}/attachments`, { method: "GET" });
    return Array.isArray(raw) ? raw : (raw.data ?? []);
  }

  /**
   * Retrieves a single inbound attachment metadata record with a fresh `download_url`.
   */
  async getReceivedAttachment(
    emailId: string,
    attachmentId: string,
  ): Promise<ResendReceivedAttachmentDetail> {
    return this.requestJson<ResendReceivedAttachmentDetail>(
      `/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "GET" },
    );
  }

  /**
   * Streams an attachment binary from a Resend temporary `download_url`, enforcing HTTPS and
   * blocking loopback/private network targets as SSRF defense-in-depth.
   */
  async fetchDownloadStream(downloadUrl: string): Promise<Response> {
    assertSafeExternalHttpsUrl(downloadUrl);
    const res = await this.fetchFn(downloadUrl, { method: "GET" });
    if (!res.ok) {
      throw new Error(`Failed to download Resend attachment (${res.status})`);
    }
    return res;
  }
}

/**
 * Validates that an external attachment download URL uses `https:` and does not point to
 * loopback, link-local, or RFC 1918 private network literals.
 */
export function assertSafeExternalHttpsUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid attachment download URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Attachment download URL must use HTTPS");
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error("Attachment download URL points to a disallowed internal host");
  }
}
