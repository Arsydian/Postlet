/**
 * @file src/worker/middleware/agent-auth.ts
 * @description Hono authentication middleware and scope guard helpers for `/api/v1/*` and `/mcp`.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { AgentKeyRecord, AgentScope } from "../../shared/types";
import type { PostletEnv, PostletVariables } from "../env";
import { authenticateAgentKey, hasMinimumScope } from "../services/agent-keys";
import { recordAuditLog } from "./audit";

/**
 * Extracts and validates the `Authorization: Bearer plt_...` token on agent routes.
 */
export const agentAuthMiddleware: MiddlewareHandler<{
  Bindings: PostletEnv;
  Variables: PostletVariables;
}> = async (c, next) => {
  const authHeader = c.req.header("Authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return c.json({ error: "Missing Authorization: Bearer <agent-api-key> header" }, 401);
  }

  const token = match[1].trim();
  const result = await authenticateAgentKey(c.env.DB, token);
  if (!result.ok) {
    return c.json({ error: result.reason }, result.status);
  }

  c.set("agentKey", result.key);
  await next();
};

/**
 * Asserts that the authenticated agent key holds at least `requiredScope`, recording a `denied`
 * audit entry when insufficient.
 */
export async function assertAgentScope(
  c: Context<{ Bindings: PostletEnv; Variables: PostletVariables }>,
  requiredScope: AgentScope,
  action: string,
): Promise<AgentKeyRecord | Response> {
  const key = c.get("agentKey");
  if (!key) {
    return c.json({ error: "Unauthenticated agent context" }, 401);
  }
  if (!hasMinimumScope(key.scope, requiredScope)) {
    await recordAuditLog(c.env.DB, {
      actorType: "agent_key",
      agentKeyId: key.id,
      actorLabel: key.name,
      action,
      resourceType: "permission",
      status: "denied",
      details: { requiredScope, actualScope: key.scope },
    });
    return c.json(
      {
        error: `Insufficient scope: '${action}' requires '${requiredScope}', key has '${key.scope}'`,
      },
      403,
    );
  }
  return key;
}
