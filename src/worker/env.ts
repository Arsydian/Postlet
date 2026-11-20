/**
 * @file src/worker/env.ts
 * @description Worker environment type contract extending the auto-generated Cloudflare `Env`
 * from `worker-configuration.d.ts` with runtime secrets and Hono context variables.
 */

import type { AgentKeyRecord } from "../shared/types";

/**
 * Runtime environment bindings and Cloudflare Dashboard Secrets available to Postlet.
 * Base bindings (`DB`, `ATTACHMENTS`, `AI`, `vars`) come directly from `worker-configuration.d.ts`
 * generated via `npx wrangler types` so bindings never drift from `wrangler.jsonc`.
 */
export interface PostletEnv extends Omit<Env, "AI"> {
  /** Optional so offline Vitest runs without remote Workers AI binding remain type-safe. */
  AI?: Env["AI"];
  /** Resend REST API key (set as Cloudflare Dashboard Secret or `.dev.vars`). */
  RESEND_API_KEY?: string;
  /** Resend Svix webhook signing secret (`whsec_...`). */
  RESEND_WEBHOOK_SECRET?: string;
  /** Cloudflare Zero Trust Access team domain (e.g. `myteam.cloudflareaccess.com`). */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Zero Trust Access application AUD tag. */
  CF_ACCESS_AUD?: string;
  /** Primary mail domain configured in Resend (fallback if not set in DB settings). */
  MAIL_DOMAIN?: string;
  /** Local-development only Access bypass flag; strictly ignored outside localhost or when AUD is set. */
  DEV_BYPASS_ACCESS?: string;
}

/** Per-request Hono context variables populated by auth middleware. */
export interface PostletVariables {
  ownerEmail?: string;
  agentKey?: AgentKeyRecord;
}
