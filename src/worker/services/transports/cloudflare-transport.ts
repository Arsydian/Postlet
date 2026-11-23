/**
 * @file src/worker/services/transports/cloudflare-transport.ts
 * @description Outbound transport backed by Cloudflare's native `send_email` Worker binding and
 * event-mapping helpers for Cloudflare Email Service queue notifications.
 */

import type { CloudflareSendEmailBinding } from "../../env";
import type { CloudflareEmailQueueEvent, MailTransport, OutboundEmailPayload, OutboundSendResult } from "./types";

function parseFormattedSender(rawFrom: string): { email: string; name?: string } {
  const trimmed = rawFrom.trim();
  const match = trimmed.match(/^(?:"?([^"]*)"?\s*)?<([^<>@\s]+@[^<>@\s]+)>$/);
  if (match) {
    const name = (match[1] ?? "").trim();
    const email = match[2].trim();
    return name ? { email, name } : { email };
  }
  return { email: trimmed };
}

/**
 * Sends transactional email via Cloudflare's native `env.EMAIL.send()` binding (Workers Paid plan).
 * Requires configuring `"send_email": [{ "name": "EMAIL" }]` in `wrangler.jsonc`.
 */
export class CloudflareEmailTransport implements MailTransport {
  readonly provider = "cloudflare" as const;
  private readonly binding: CloudflareSendEmailBinding | undefined;

  constructor(binding: CloudflareSendEmailBinding | undefined) {
    this.binding = binding;
  }

  async sendEmail(input: OutboundEmailPayload): Promise<OutboundSendResult> {
    if (!this.binding) {
      throw new Error(
        "Cloudflare EMAIL send_email binding is not configured in wrangler.jsonc (requires Workers Paid plan).",
      );
    }

    const fromObj = parseFormattedSender(input.from);
    const res = await this.binding.send({
      from: fromObj,
      to: input.to.length === 1 ? input.to[0] : input.to,
      ...(input.cc && input.cc.length > 0 ? { cc: input.cc } : {}),
      ...(input.bcc && input.bcc.length > 0 ? { bcc: input.bcc } : {}),
      ...(input.reply_to ? { replyTo: input.reply_to } : {}),
      subject: input.subject,
      ...(input.text ? { text: input.text } : {}),
      ...(input.html ? { html: input.html } : {}),
      ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
      ...(input.attachments && input.attachments.length > 0
        ? {
            attachments: input.attachments.map((att) => ({
              filename: att.filename,
              content: att.content,
              type: att.content_type || "application/octet-stream",
              disposition: "attachment" as const,
            })),
          }
        : {}),
    });

    const resolvedId =
      res?.messageId || input.headers?.["Message-ID"] || `cf_${crypto.randomUUID()}`;

    const bounced = res?.permanent_bounces ?? [];
    const delivered = res?.delivered ?? [];
    let initialStatus: OutboundSendResult["initialStatus"] = "sent";
    let deliveryError: string | undefined;

    if (bounced.length > 0 && delivered.length === 0) {
      initialStatus = "bounced";
      deliveryError = `Permanent bounce for ${bounced.join(", ")}`;
    } else if (delivered.length > 0 && bounced.length === 0) {
      initialStatus = "delivered";
    }

    return {
      id: resolvedId,
      initialStatus,
      ...(deliveryError ? { deliveryError } : {}),
    };
  }
}

/**
 * Translates a Cloudflare Email Service Queue event into Postlet's unified webhook event shape
 * consumed by `applyDeliveryWebhookEvent()`.
 */
export function mapCloudflareQueueEventToDeliveryEvent(
  raw: CloudflareEmailQueueEvent | unknown,
): {
  eventType: string;
  email_id: string;
  reason?: string;
  timestamp?: string;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const ev = raw as CloudflareEmailQueueEvent;
  const emailId = (ev.messageId || ev.emailId || "").trim();
  if (!emailId) return null;

  const rawType = (ev.type || ev.eventType || ev.status || "").trim().toLowerCase();
  const detail = ev.errorDetail || ev.errorCause || ev.reason;
  const timestamp = ev.timestamp || ev.datetime;

  const typeMap: Record<string, string> = {
    "message.sent": "email.sent",
    "message.delivered": "email.delivered",
    delivered: "email.delivered",
    "message.deferred": "email.delivery_delayed",
    deferred: "email.delivery_delayed",
    "message.bounced": "email.bounced",
    bounced: "email.bounced",
    "message.failed": "email.bounced",
    deliveryfailed: "email.bounced",
    "message.rejected": "email.bounced",
    "message.complained": "email.complained",
    complained: "email.complained",
  };

  const mapped = typeMap[rawType];
  if (!mapped) return null;

  return {
    eventType: mapped,
    email_id: emailId,
    ...(detail ? { reason: detail } : {}),
    ...(timestamp ? { timestamp } : {}),
  };
}
