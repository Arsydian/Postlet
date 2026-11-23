/**
 * @file src/worker/env.ts
 * @description Worker environment type contract extending the auto-generated Cloudflare `Env`
 * from `worker-configuration.d.ts` with runtime secrets, optional paid email bindings, and Hono
 * context variables.
 */

import type { AgentKeyRecord } from "../shared/types";

export interface CloudflareSendEmailAddress {
  email: string;
  name?: string;
}

export interface CloudflareSendEmailAttachment {
  filename: string;
  content: string | ArrayBuffer | ArrayBufferView;
  type: string;
  disposition: "attachment" | "inline";
  contentId?: string;
}

export interface CloudflareSendEmailRequest {
  from: string | CloudflareSendEmailAddress;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: CloudflareSendEmailAttachment[];
}

export interface CloudflareSendEmailResponse {
  messageId?: string;
  delivered?: string[];
  permanent_bounces?: string[];
  queued?: string[];
}

export interface CloudflareSendEmailBinding {
  send(message: CloudflareSendEmailRequest): Promise<CloudflareSendEmailResponse | void>;
}

/**
 * Runtime environment bindings and Cloudflare Dashboard Secrets available to Postlet.
 * Base bindings (`DB`, `ATTACHMENTS`, `AI`, `vars`) come directly from `worker-configuration.d.ts`
 * generated via `npx wrangler types` so bindings never drift from `wrangler.jsonc`.
 */
export interface PostletEnv extends Omit<Env, "AI" | "MAIL_PROVIDER"> {
  /** Optional so offline Vitest runs without remote Workers AI binding remain type-safe. */
  AI?: Env["AI"];
  /** Optional Cloudflare Email Service outbound `send_email` binding (Workers Paid plan). */
  EMAIL?: CloudflareSendEmailBinding;
  /** Outbound transport provider selector: `"resend"` (default) | `"cloudflare"` | `"ses"`. */
  MAIL_PROVIDER?: string;
  /** Resend REST API key (set as Cloudflare Dashboard Secret or `.dev.vars`). */
  RESEND_API_KEY?: string;
  /** Resend Svix webhook signing secret (`whsec_...`). */
  RESEND_WEBHOOK_SECRET?: string;
  /** Amazon SES IAM Access Key ID (for `MAIL_PROVIDER=ses`). */
  AWS_SES_ACCESS_KEY_ID?: string;
  /** Amazon SES IAM Secret Access Key (for `MAIL_PROVIDER=ses`). */
  AWS_SES_SECRET_ACCESS_KEY?: string;
  /** Amazon SES AWS region (e.g., `"us-east-1"`). */
  AWS_SES_REGION?: string;
  /** Optional Amazon SES Configuration Set name for Open/Click/Delivery event publishing. */
  AWS_SES_CONFIGURATION_SET?: string;
  /** Optional extra shared webhook secret token for `/api/webhooks/ses`. */
  SES_WEBHOOK_SECRET?: string;
  /** Optional strict Amazon SNS Topic ARN allowlist for `/api/webhooks/ses`. */
  SES_SNS_TOPIC_ARN?: string;
  /** Public origin for self-hosted open/click tracking (e.g., `https://mail.example.com`). */
  TRACKING_BASE_URL?: string;
  /** HMAC-SHA256 signing secret for self-hosted `/t/o/:token` and `/t/c/:token` tracking URLs. */
  TRACKING_SECRET?: string;
  /** Cloudflare Zero Trust Access team domain (e.g. `myteam.cloudflareaccess.com`). */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Zero Trust Access application AUD tag. */
  CF_ACCESS_AUD?: string;
  /** Primary mail domain(s) (comma-separated fallback before D1 Settings override). */
  MAIL_DOMAIN?: string;
  /** Local-development only Access bypass flag; strictly ignored outside localhost or when AUD is set. */
  DEV_BYPASS_ACCESS?: string;
}

/** Per-request Hono context variables populated by auth middleware. */
export interface PostletVariables {
  ownerEmail?: string;
  agentKey?: AgentKeyRecord;
}
