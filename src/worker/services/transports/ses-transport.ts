/**
 * @file src/worker/services/transports/ses-transport.ts
 * @description Outbound Amazon SES v2 REST API transport signed with Web Crypto AWS SigV4 (zero
 * AWS SDK dependencies), RFC 5322 MIME builder, and cryptographic Amazon SNS webhook verifier.
 */

import { base64ToBytes, bytesToBase64 } from "../../lib/crypto";
import type { MailTransport, OutboundEmailPayload, OutboundSendResult } from "./types";

const textEncoder = new TextEncoder();

export interface SesTransportConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  configurationSet?: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256HexBytes(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256(
  keyBytes: Uint8Array<ArrayBuffer>,
  message: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(message));
  return new Uint8Array(sig) as Uint8Array<ArrayBuffer>;
}

function encodeRfc2047IfNeeded(value: string): string {
  const cleaned = value.replace(/[\r\n]+/g, " ").trim();
  if (!cleaned || /^[\x20-\x7e]*$/.test(cleaned)) {
    return cleaned;
  }
  const encoded = bytesToBase64(textEncoder.encode(cleaned));
  return `=?UTF-8?B?${encoded}?=`;
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function wrapBase6476(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

function normalizeCrLf(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

function formatFromHeader(rawFrom: string): { displayHeader: string; emailOnly: string } {
  const trimmed = sanitizeHeaderValue(rawFrom);
  const match = trimmed.match(/^(?:"?([^"]*)"?\s*)?<([^<>@\s]+@[^<>@\s]+)>$/);
  if (match) {
    const name = (match[1] ?? "").trim();
    const email = match[2].trim();
    if (!name) return { displayHeader: email, emailOnly: email };
    const safeName = encodeRfc2047IfNeeded(name.replace(/"/g, ""));
    return {
      displayHeader: /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/"/g, "")}" <${email}>` : `${safeName} <${email}>`,
      emailOnly: email,
    };
  }
  return { displayHeader: trimmed, emailOnly: trimmed };
}

/**
 * Constructs a compliant RFC 5322 / MIME raw message supporting HTML + plain-text alternatives,
 * threading headers, and base64-encoded attachments while excluding Bcc headers from the wire payload.
 */
export function buildRawMimeMessage(input: OutboundEmailPayload): {
  rawMime: string;
  fromEmailAddress: string;
} {
  const { displayHeader, emailOnly } = formatFromHeader(input.from);
  const headers: string[] = [
    `From: ${displayHeader}`,
    `To: ${input.to.map(sanitizeHeaderValue).join(", ")}`,
  ];

  if (input.cc && input.cc.length > 0) {
    headers.push(`Cc: ${input.cc.map(sanitizeHeaderValue).join(", ")}`);
  }
  if (input.reply_to) {
    headers.push(`Reply-To: ${sanitizeHeaderValue(input.reply_to)}`);
  }

  headers.push(`Subject: ${encodeRfc2047IfNeeded(input.subject)}`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  headers.push(`MIME-Version: 1.0`);

  const reserved = new Set(["from", "to", "cc", "bcc", "reply-to", "subject", "date", "mime-version"]);
  if (input.headers) {
    for (const [key, val] of Object.entries(input.headers)) {
      const cleanKey = sanitizeHeaderValue(key);
      if (!cleanKey || reserved.has(cleanKey.toLowerCase())) continue;
      headers.push(`${cleanKey}: ${sanitizeHeaderValue(val)}`);
    }
  }

  const hasText = Boolean(input.text && input.text.length > 0);
  const hasHtml = Boolean(input.html && input.html.length > 0);
  const attachments = input.attachments ?? [];

  const textBody = normalizeCrLf(input.text ?? "");
  const htmlBody = normalizeCrLf(input.html ?? "");
  const altBoundary = `=_postlet_alt_${crypto.randomUUID().replace(/-/g, "")}`;
  const mixedBoundary = `=_postlet_mix_${crypto.randomUUID().replace(/-/g, "")}`;

  const renderAlternativeBody = (): string => {
    if (hasText && hasHtml) {
      return [
        `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
        ``,
        `--${altBoundary}`,
        `Content-Type: text/plain; charset="UTF-8"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        wrapBase6476(bytesToBase64(textEncoder.encode(textBody))),
        `--${altBoundary}`,
        `Content-Type: text/html; charset="UTF-8"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        wrapBase6476(bytesToBase64(textEncoder.encode(htmlBody))),
        `--${altBoundary}--`,
      ].join("\r\n");
    }
    if (hasHtml) {
      return [
        `Content-Type: text/html; charset="UTF-8"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        wrapBase6476(bytesToBase64(textEncoder.encode(htmlBody))),
      ].join("\r\n");
    }
    return [
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      wrapBase6476(bytesToBase64(textEncoder.encode(textBody))),
    ].join("\r\n");
  };

  if (attachments.length === 0) {
    return {
      rawMime: `${headers.join("\r\n")}\r\n${renderAlternativeBody()}`,
      fromEmailAddress: emailOnly,
    };
  }

  const attachmentParts = attachments.map((att) => {
    const safeName = sanitizeHeaderValue(att.filename).replace(/"/g, "");
    const safeMime = sanitizeHeaderValue(att.content_type || "application/octet-stream");
    return [
      `--${mixedBoundary}`,
      `Content-Type: ${safeMime}; name="${safeName}"`,
      `Content-Disposition: attachment; filename="${safeName}"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      wrapBase6476(att.content),
    ].join("\r\n");
  });

  const mixedBody = [
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    ``,
    `--${mixedBoundary}`,
    renderAlternativeBody(),
    ...attachmentParts,
    `--${mixedBoundary}--`,
  ].join("\r\n");

  return {
    rawMime: `${headers.join("\r\n")}\r\n${mixedBody}`,
    fromEmailAddress: emailOnly,
  };
}

/**
 * Computes AWS Signature Version 4 headers for an HTTP request using Web Crypto SHA-256 & HMAC-SHA256.
 */
export async function signAwsV4Request(params: {
  method: string;
  url: URL;
  body: string;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: Date;
}): Promise<Record<string, string>> {
  const now = params.now ?? new Date();
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const amzDate = iso;
  const dateStamp = iso.slice(0, 8);
  const bodyBytes = textEncoder.encode(params.body) as Uint8Array<ArrayBuffer>;
  const payloadHash = await sha256HexBytes(bodyBytes);

  const canonicalHeaders =
    `host:${params.url.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    params.method.toUpperCase(),
    params.url.pathname || "/",
    params.url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const canonicalHash = await sha256HexBytes(
    textEncoder.encode(canonicalRequest) as Uint8Array<ArrayBuffer>,
  );
  const credentialScope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${canonicalHash}`;

  const kDate = await hmacSha256(
    textEncoder.encode(`AWS4${params.secretAccessKey}`) as Uint8Array<ArrayBuffer>,
    dateStamp,
  );
  const kRegion = await hmacSha256(kDate, params.region);
  const kService = await hmacSha256(kRegion, params.service);
  const kSigning = await hmacSha256(kService, "aws4_request");
  const signature = bytesToHex(await hmacSha256(kSigning, stringToSign));

  return {
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Outbound Amazon SES v2 REST client built specifically for Cloudflare Workers (raw MIME + AWS SigV4).
 */
export class SesEmailTransport implements MailTransport {
  readonly provider = "ses" as const;
  private readonly config: SesTransportConfig;
  private readonly fetchFn: typeof fetch;
  private readonly region: string;
  private readonly endpointUrl: string;

  constructor(config: SesTransportConfig, fetchFn?: typeof fetch, endpointUrl?: string) {
    this.config = config;
    this.region = (config.region || "us-east-1").trim();
    this.endpointUrl = (
      endpointUrl || `https://email.${this.region}.amazonaws.com/v2/email/outbound-emails`
    ).replace(/\/+$/, "");
    // Arrow wrapper prevents Cloudflare Workers `Illegal invocation` on native `fetch`.
    this.fetchFn =
      !fetchFn || fetchFn === globalThis.fetch
        ? (input, init) => globalThis.fetch(input, init)
        : (input, init) => fetchFn(input, init);
  }

  async sendEmail(input: OutboundEmailPayload): Promise<OutboundSendResult> {
    if (!this.config.accessKeyId || !this.config.secretAccessKey) {
      throw new Error("AWS_SES_ACCESS_KEY_ID and AWS_SES_SECRET_ACCESS_KEY are required for SES");
    }

    const { rawMime, fromEmailAddress } = buildRawMimeMessage(input);
    const rawDataBase64 = bytesToBase64(textEncoder.encode(rawMime));

    const payload: Record<string, unknown> = {
      FromEmailAddress: fromEmailAddress,
      Destination: {
        ToAddresses: input.to,
        ...(input.cc && input.cc.length > 0 ? { CcAddresses: input.cc } : {}),
        ...(input.bcc && input.bcc.length > 0 ? { BccAddresses: input.bcc } : {}),
      },
      Content: {
        Raw: { Data: rawDataBase64 },
      },
    };
    if (this.config.configurationSet) {
      payload.ConfigurationSetName = this.config.configurationSet;
    }

    const body = JSON.stringify(payload);
    const url = new URL(this.endpointUrl);
    const sigHeaders = await signAwsV4Request({
      method: "POST",
      url,
      body,
      service: "ses",
      region: this.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
    });

    const res = await this.fetchFn(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...sigHeaders,
      },
      body,
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Amazon SES API ${res.status}: ${errorText}`);
    }

    const data = (await res.json()) as { MessageId?: string };
    return {
      id: data.MessageId || input.headers?.["Message-ID"] || `ses_${crypto.randomUUID()}`,
      initialStatus: "sent",
    };
  }
}

// ---------------------------------------------------------------------------
// Amazon SNS Webhook Verification & SES Event Parsing
// ---------------------------------------------------------------------------

export interface SnsMessageEnvelope {
  Type: string;
  MessageId: string;
  TopicArn?: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
}

/**
 * Validates that an Amazon SNS `SigningCertURL` or `SubscribeURL` uses HTTPS on an authentic
 * `sns.<region>.amazonaws.com` hostname to prevent SSRF attacks.
 */
export function isTrustedSnsUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return /^sns\.[a-z0-9-]+\.amazonaws\.com$/i.test(parsed.hostname);
}

/**
 * Builds the canonical newline-delimited signing string defined by Amazon SNS.
 */
export function buildSnsCanonicalSigningString(msg: SnsMessageEnvelope): string {
  const fields: Array<[string, string | undefined]> =
    msg.Type === "Notification"
      ? [
          ["Message", msg.Message],
          ["MessageId", msg.MessageId],
          ["Subject", msg.Subject],
          ["Timestamp", msg.Timestamp],
          ["TopicArn", msg.TopicArn],
          ["Type", msg.Type],
        ]
      : [
          ["Message", msg.Message],
          ["MessageId", msg.MessageId],
          ["SubscribeURL", msg.SubscribeURL],
          ["Timestamp", msg.Timestamp],
          ["Token", msg.Token],
          ["TopicArn", msg.TopicArn],
          ["Type", msg.Type],
        ];

  const lines: string[] = [];
  for (const [k, v] of fields) {
    if (v !== undefined) {
      lines.push(k, v);
    }
  }
  return `${lines.join("\n")}\n`;
}

function readDerTlv(
  bytes: Uint8Array,
  offset: number,
): { tag: number; headerLen: number; contentLen: number; nextOffset: number } {
  if (offset >= bytes.length) {
    throw new Error("Unexpected end of DER data");
  }
  const tag = bytes[offset];
  const lenByte = bytes[offset + 1];
  let contentLen = 0;
  let headerLen = 2;
  if (lenByte < 0x80) {
    contentLen = lenByte;
  } else {
    const octets = lenByte & 0x7f;
    if (octets === 0 || octets > 4 || offset + 2 + octets > bytes.length) {
      throw new Error("Invalid DER length octets");
    }
    headerLen = 2 + octets;
    for (let i = 0; i < octets; i += 1) {
      contentLen = (contentLen << 8) | bytes[offset + 2 + i];
    }
  }
  const nextOffset = offset + headerLen + contentLen;
  if (nextOffset > bytes.length) {
    throw new Error("DER element extends past buffer");
  }
  return { tag, headerLen, contentLen, nextOffset };
}

/**
 * Extracts the ASN.1 DER `SubjectPublicKeyInfo` byte slice from an X.509 PEM certificate so it can
 * be imported natively via Web Crypto `crypto.subtle.importKey("spki", ...)`.
 */
export function extractSpkiFromX509Pem(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  if (!b64) {
    throw new Error("Empty PEM certificate");
  }

  const der = base64ToBytes(b64);
  const certSeq = readDerTlv(der, 0);
  if (certSeq.tag !== 0x30) throw new Error("Expected X.509 Certificate SEQUENCE");

  const tbsSeq = readDerTlv(der, certSeq.headerLen);
  if (tbsSeq.tag !== 0x30) throw new Error("Expected TBSCertificate SEQUENCE");

  let cursor = certSeq.headerLen + tbsSeq.headerLen;
  // Skip optional [0] EXPLICIT version tag
  if (der[cursor] === 0xa0) {
    cursor = readDerTlv(der, cursor).nextOffset;
  }
  // Skip serialNumber, signature AlgorithmIdentifier, issuer, validity, subject
  for (let i = 0; i < 5; i += 1) {
    cursor = readDerTlv(der, cursor).nextOffset;
  }

  const spkiStart = cursor;
  const spkiTlv = readDerTlv(der, spkiStart);
  if (spkiTlv.tag !== 0x30) throw new Error("Expected SubjectPublicKeyInfo SEQUENCE");

  const copy = new Uint8Array(new ArrayBuffer(spkiTlv.nextOffset - spkiStart));
  copy.set(der.subarray(spkiStart, spkiTlv.nextOffset));
  return copy;
}

/**
 * Cryptographically verifies an incoming Amazon SNS webhook payload using the PEM certificate at
 * `SigningCertURL` (validated against `*.amazonaws.com`). Supports SHA-1 (`SignatureVersion: "1"`)
 * and SHA-256 (`SignatureVersion: "2"`).
 */
export async function verifySnsSignature(
  msg: SnsMessageEnvelope,
  fetchFn?: typeof fetch,
): Promise<boolean> {
  if (!msg || !msg.Signature || !msg.SigningCertURL || !isTrustedSnsUrl(msg.SigningCertURL)) {
    return false;
  }

  const safeFetch: typeof fetch =
    !fetchFn || fetchFn === globalThis.fetch
      ? (input, init) => globalThis.fetch(input, init)
      : (input, init) => fetchFn(input, init);

  let certRes: Response;
  try {
    certRes = await safeFetch(msg.SigningCertURL, { method: "GET" });
    if (!certRes.ok) return false;
  } catch {
    return false;
  }

  try {
    const pem = await certRes.text();
    const spki = extractSpkiFromX509Pem(pem);
    const hashAlg = msg.SignatureVersion === "2" ? "SHA-256" : "SHA-1";
    const key = await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "RSASSA-PKCS1-v1_5", hash: hashAlg },
      false,
      ["verify"],
    );
    const canonical = buildSnsCanonicalSigningString(msg);
    const signatureBytes = base64ToBytes(msg.Signature);
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signatureBytes,
      textEncoder.encode(canonical),
    );
  } catch {
    return false;
  }
}

/**
 * Parses an Amazon SES event payload nested inside an SNS `Notification.Message` JSON string into
 * Postlet's unified `applyDeliveryWebhookEvent()` parameters.
 */
export function parseSesSnsNotification(messageJson: string): {
  eventType: string;
  eventData: {
    email_id?: string;
    bounce?: { message?: string; subType?: string; type?: string };
    reason?: string;
    click?: { link?: string; ipAddress?: string; timestamp?: string };
  };
  timestamp?: string;
} | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(messageJson) as Record<string, unknown>;
  } catch {
    return null;
  }

  const rawType = String(payload.eventType || payload.notificationType || "").trim();
  const mail = payload.mail as { messageId?: string; timestamp?: string } | undefined;
  const emailId = mail?.messageId;
  if (!rawType || !emailId) return null;

  const eventMap: Record<string, string> = {
    Send: "email.sent",
    Delivery: "email.delivered",
    DeliveryDelay: "email.delivery_delayed",
    Bounce: "email.bounced",
    Complaint: "email.complained",
    Open: "email.opened",
    Click: "email.clicked",
  };
  const mappedType = eventMap[rawType];
  if (!mappedType) return null;

  const bounceObj = payload.bounce as
    | { bounceType?: string; bounceSubType?: string; bouncedRecipients?: Array<{ diagnosticCode?: string }> }
    | undefined;
  const complaintObj = payload.complaint as { complaintFeedbackType?: string } | undefined;
  const delayObj = payload.deliveryDelay as { delayType?: string } | undefined;
  const clickObj = payload.click as { link?: string; ipAddress?: string; timestamp?: string } | undefined;
  const openObj = payload.open as { timestamp?: string } | undefined;
  const deliveryObj = payload.delivery as { timestamp?: string } | undefined;

  return {
    eventType: mappedType,
    eventData: {
      email_id: emailId,
      ...(bounceObj
        ? {
            bounce: {
              type: bounceObj.bounceType,
              subType: bounceObj.bounceSubType,
              message: bounceObj.bouncedRecipients?.[0]?.diagnosticCode,
            },
          }
        : {}),
      ...(complaintObj?.complaintFeedbackType
        ? { reason: `Complaint: ${complaintObj.complaintFeedbackType}` }
        : {}),
      ...(delayObj?.delayType ? { reason: `Delayed: ${delayObj.delayType}` } : {}),
      ...(clickObj?.link ? { click: clickObj } : {}),
    },
    timestamp:
      clickObj?.timestamp ||
      openObj?.timestamp ||
      deliveryObj?.timestamp ||
      mail?.timestamp,
  };
}
