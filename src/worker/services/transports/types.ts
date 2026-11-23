/**
 * @file src/worker/services/transports/types.ts
 * @description Provider-agnostic outbound email transport contract and Cloudflare Email Service
 * queue event types shared across Resend, Cloudflare Email Sending, and Amazon SES transports.
 */

import type { MailProviderId, MessageStatus } from "../../../shared/types";

export interface OutboundAttachment {
  filename: string;
  content: string; // Base64-encoded content
  content_type?: string;
}

export interface OutboundEmailPayload {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: OutboundAttachment[];
}

export interface OutboundSendResult {
  id: string;
  /** Optional immediate delivery outcome reported synchronously by providers like Cloudflare Email Service. */
  initialStatus?: Extract<MessageStatus, "sent" | "delivered" | "bounced">;
  deliveryError?: string;
}

export interface MailTransport {
  readonly provider?: MailProviderId;
  sendEmail(input: OutboundEmailPayload): Promise<OutboundSendResult>;
}

export interface CloudflareEmailQueueEvent {
  type?: string;
  eventType?: string;
  messageId?: string;
  emailId?: string;
  status?: string;
  reason?: string;
  errorCause?: string;
  errorDetail?: string;
  timestamp?: string;
  datetime?: string;
}
