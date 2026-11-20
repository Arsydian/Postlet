/**
 * @file src/worker/middleware/audit.ts
 * @description Unified audit logging service recording actions across external AI agent keys,
 * the built-in Cloudflare Workers AI agent (`postlet_ai`), and owner approval/rejection events.
 */

import type { AuditLogRecord } from "../../shared/types";

export interface RecordAuditParams {
  actorType: "agent_key" | "postlet_ai" | "owner";
  agentKeyId?: string | null;
  actorLabel: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  status: "allowed" | "denied" | "error";
  details?: Record<string, unknown>;
}

interface AuditRow {
  id: string;
  actor_type: "agent_key" | "postlet_ai" | "owner";
  agent_key_id: string | null;
  actor_label: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  status: "allowed" | "denied" | "error";
  details_json: string;
  created_at: string;
}

/**
 * Persists a single structured audit record to D1.
 *
 * @param db D1 database binding.
 * @param params Audit event fields.
 * @returns Generated audit log ID.
 */
export async function recordAuditLog(db: D1Database, params: RecordAuditParams): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO agent_audit_logs
       (id, actor_type, agent_key_id, actor_label, action, resource_type, resource_id, status, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      params.actorType,
      params.agentKeyId ?? null,
      params.actorLabel,
      params.action,
      params.resourceType,
      params.resourceId ?? null,
      params.status,
      JSON.stringify(params.details ?? {}),
      now,
    )
    .run();
  return id;
}

/**
 * Lists recent audit log entries with optional actor type or key filtering.
 *
 * @param db D1 database binding.
 * @param options Filter and pagination options.
 * @returns Array of typed audit log records ordered newest first.
 */
export async function listAuditLogs(
  db: D1Database,
  options?: {
    actorType?: string;
    agentKeyId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  },
): Promise<AuditLogRecord[]> {
  const clauses: string[] = [];
  const bindings: unknown[] = [];

  if (options?.actorType) {
    clauses.push("actor_type = ?");
    bindings.push(options.actorType);
  }
  if (options?.agentKeyId) {
    clauses.push("agent_key_id = ?");
    bindings.push(options.agentKeyId);
  }
  if (options?.status) {
    clauses.push("status = ?");
    bindings.push(options.status);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  const offset = Math.max(options?.offset ?? 0, 0);

  const result = await db
    .prepare(
      `SELECT id, actor_type, agent_key_id, actor_label, action, resource_type, resource_id, status, details_json, created_at
       FROM agent_audit_logs
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, limit, offset)
    .all<AuditRow>();

  return (result.results ?? []).map((row) => {
    let details: Record<string, unknown> = {};
    try {
      details = JSON.parse(row.details_json) as Record<string, unknown>;
    } catch {
      details = {};
    }
    return {
      id: row.id,
      actorType: row.actor_type,
      agentKeyId: row.agent_key_id,
      actorLabel: row.actor_label,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      status: row.status,
      details,
      createdAt: row.created_at,
    };
  });
}
