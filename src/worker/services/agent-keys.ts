/**
 * @file src/worker/services/agent-keys.ts
 * @description Manages scoped AI agent API keys (SHA-256 hashed at rest), enforces alias locks,
 * recipient domain allowlists, and hourly rate limits, and builds onboarding snippets.
 */

import { emailSchema } from "../../shared/schemas";
import type {
  AgentKeyRecord,
  AgentOnboardingSnippets,
  AgentScope,
  BuiltInAiFunction,
} from "../../shared/types";
import { generateSecureToken, sha256Hex, timingSafeEqualStrings } from "../lib/crypto";
import { findAddressById } from "./addresses";

interface AgentKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scope: AgentScope;
  allowed_address_id: string | null;
  allowed_address_email: string | null;
  allowed_recipient_domains_json: string | null;
  allowed_functions_json: string;
  rate_limit_per_hour: number;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const SCOPE_RANK: Record<AgentScope, number> = {
  read_only: 1,
  read_draft: 2,
  read_write: 3,
};

function parseJsonOrNull<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function mapAgentKeyRow(row: AgentKeyRow): AgentKeyRecord {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scope: row.scope,
    allowedAddressId: row.allowed_address_id,
    allowedAddressEmail: row.allowed_address_email ?? null,
    allowedRecipientDomains: parseJsonOrNull<string[]>(row.allowed_recipient_domains_json),
    allowedFunctions: parseJsonOrNull<BuiltInAiFunction[]>(row.allowed_functions_json) ?? [
      "daily_summary",
      "important_auto_reply",
      "triage",
    ],
    rateLimitPerHour: row.rate_limit_per_hour,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

/**
 * Checks whether an agent key's scope satisfies the minimum required tier.
 */
export function hasMinimumScope(actual: AgentScope, required: AgentScope): boolean {
  return SCOPE_RANK[actual] >= SCOPE_RANK[required];
}

/**
 * Checks whether a given built-in AI function is permitted for the agent key.
 */
export function hasAllowedFunction(key: AgentKeyRecord, fn: BuiltInAiFunction): boolean {
  return key.allowedFunctions.includes(fn);
}

/**
 * Generates ready-to-copy MCP JSON, curl, and OpenAPI snippets for an agent key.
 */
export function buildAgentSnippets(
  origin: string,
  plaintextKey: string,
): AgentOnboardingSnippets {
  const cleanOrigin = origin.replace(/\/+$/, "");
  const mcpConfig = {
    mcpServers: {
      postlet: {
        url: `${cleanOrigin}/mcp`,
        headers: {
          Authorization: `Bearer ${plaintextKey}`,
        },
      },
    },
  };

  return {
    mcpConfigJson: JSON.stringify(mcpConfig, null, 2),
    curlCommand: `curl -sS "${cleanOrigin}/api/v1/threads?folder=inbox" \\\n  -H "Authorization: Bearer ${plaintextKey}"`,
    openApiUrl: `${cleanOrigin}/api/v1/openapi.json`,
  };
}

/**
 * Creates a new agent API key, stores only its SHA-256 hash in D1, and returns the plaintext
 * secret once alongside onboarding snippets.
 */
export async function createAgentKey(
  db: D1Database,
  input: {
    name: string;
    scope: AgentScope;
    allowedAddressId?: string | null;
    allowedRecipientDomains?: string[] | null;
    allowedFunctions?: BuiltInAiFunction[];
    rateLimitPerHour?: number;
  },
  origin: string,
): Promise<{
  key: AgentKeyRecord;
  plaintextSecret: string;
  snippets: AgentOnboardingSnippets;
}> {
  if (input.allowedAddressId) {
    const addr = await findAddressById(db, input.allowedAddressId);
    if (!addr) {
      throw new Error("Referenced allowed address does not exist");
    }
  }

  const id = crypto.randomUUID();
  const plaintextSecret = generateSecureToken("plt_", 24);
  const keyPrefix = plaintextSecret.slice(0, 12);
  const keyHash = await sha256Hex(plaintextSecret);
  const now = new Date().toISOString();

  const normalizedDomains =
    input.allowedRecipientDomains && input.allowedRecipientDomains.length > 0
      ? Array.from(new Set(input.allowedRecipientDomains.map((d) => d.trim().toLowerCase())))
      : null;
  const allowedFunctions: BuiltInAiFunction[] = input.allowedFunctions ?? [
    "daily_summary",
    "important_auto_reply",
    "triage",
  ];
  const rateLimit = input.rateLimitPerHour ?? 60;

  await db
    .prepare(
      `INSERT INTO agent_keys
       (id, name, key_prefix, key_hash, scope, allowed_address_id, allowed_recipient_domains_json,
        allowed_functions_json, rate_limit_per_hour, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.name.trim(),
      keyPrefix,
      keyHash,
      input.scope,
      input.allowedAddressId ?? null,
      normalizedDomains ? JSON.stringify(normalizedDomains) : null,
      JSON.stringify(allowedFunctions),
      rateLimit,
      now,
    )
    .run();

  const row = await db
    .prepare(
      `SELECT k.*, a.email AS allowed_address_email
       FROM agent_keys k
       LEFT JOIN addresses a ON a.id = k.allowed_address_id
       WHERE k.id = ?`,
    )
    .bind(id)
    .first<AgentKeyRow>();

  if (!row) {
    throw new Error("Failed to read back created agent key");
  }

  return {
    key: mapAgentKeyRow(row),
    plaintextSecret,
    snippets: buildAgentSnippets(origin, plaintextSecret),
  };
}

/**
 * Lists all agent keys (active and revoked) without exposing hashes.
 */
export async function listAgentKeys(db: D1Database): Promise<AgentKeyRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT k.*, a.email AS allowed_address_email
       FROM agent_keys k
       LEFT JOIN addresses a ON a.id = k.allowed_address_id
       ORDER BY k.revoked_at IS NOT NULL ASC, k.created_at DESC`,
    )
    .all<AgentKeyRow>();
  return (results ?? []).map(mapAgentKeyRow);
}

/**
 * Soft-revokes an agent key so future requests fail immediately while preserving audit history.
 */
export async function revokeAgentKey(db: D1Database, id: string): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE agent_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(new Date().toISOString(), id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export type AuthenticateAgentResult =
  | { ok: true; key: AgentKeyRecord }
  | { ok: false; status: 401 | 429; reason: string };

/**
 * Authenticates an agent Bearer token using SHA-256 hash lookup + constant-time verification
 * and enforces the key's per-hour rate limit against recent audit logs.
 */
export async function authenticateAgentKey(
  db: D1Database,
  bearerToken: string,
): Promise<AuthenticateAgentResult> {
  if (!bearerToken.startsWith("plt_") || bearerToken.length < 20) {
    return { ok: false, status: 401, reason: "Unauthorized" };
  }

  const candidateHash = await sha256Hex(bearerToken);
  const row = await db
    .prepare(
      `SELECT k.*, a.email AS allowed_address_email
       FROM agent_keys k
       LEFT JOIN addresses a ON a.id = k.allowed_address_id
       WHERE k.key_hash = ?`,
    )
    .bind(candidateHash)
    .first<AgentKeyRow>();

  if (!row) {
    return { ok: false, status: 401, reason: "Unauthorized" };
  }

  if (!(await timingSafeEqualStrings(candidateHash, row.key_hash))) {
    return { ok: false, status: 401, reason: "Unauthorized" };
  }

  if (row.revoked_at) {
    return { ok: false, status: 401, reason: "Unauthorized" };
  }

  // Count ALL audited calls (allowed, denied, and error) in the past hour so denied probes cannot bypass rate limits.
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
  const countRow = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM agent_audit_logs
       WHERE agent_key_id = ? AND created_at >= ?`,
    )
    .bind(row.id, oneHourAgo)
    .first<{ cnt: number }>();

  if ((countRow?.cnt ?? 0) >= row.rate_limit_per_hour) {
    return {
      ok: false,
      status: 429,
      reason: `Hourly rate limit exceeded (${row.rate_limit_per_hour}/hour)`,
    };
  }

  // Throttle last_used_at writes (at most once per 60s) to conserve D1 Free-Tier write operations.
  const lastUsedMs = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  if (!lastUsedMs || Date.now() - lastUsedMs > 60_000) {
    await db
      .prepare(`UPDATE agent_keys SET last_used_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), row.id)
      .run();
  }

  return { ok: true, key: mapAgentKeyRow(row) };
}

/**
 * Validates that an outbound draft or send respects the agent key's alias lock and
 * recipient domain allowlist. Strictly validates every recipient email format first so
 * malformed addresses containing multiple `@` characters cannot bypass domain checks.
 *
 * @returns Null when allowed, or a human-readable denial reason string.
 */
export function validateAgentSendGuardrails(
  key: AgentKeyRecord,
  resolvedFromAddress: string,
  recipients: string[],
): string | null {
  if (
    key.allowedAddressEmail &&
    resolvedFromAddress.trim().toLowerCase() !== key.allowedAddressEmail.toLowerCase()
  ) {
    return `Agent key is restricted to sending as ${key.allowedAddressEmail}`;
  }

  for (const rawRecipient of recipients) {
    const parsed = emailSchema.safeParse(rawRecipient);
    if (!parsed.success) {
      return `Invalid recipient email address: ${rawRecipient}`;
    }
    if (key.allowedRecipientDomains && key.allowedRecipientDomains.length > 0) {
      const normalized = parsed.data;
      const atIdx = normalized.lastIndexOf("@");
      const domain = atIdx > 0 ? normalized.slice(atIdx + 1) : "";
      const allowedSet = new Set(key.allowedRecipientDomains.map((d) => d.toLowerCase()));
      if (!allowedSet.has(domain)) {
        return `Recipient domain '${domain}' is not in this agent key's allowlist`;
      }
    }
  }

  return null;
}
