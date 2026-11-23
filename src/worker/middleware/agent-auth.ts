/**
 * @file src/worker/middleware/agent-auth.ts
 * @description Hono authentication middleware and scope guard helpers for `/api/v1/*` and `/mcp`.
 * Enforces `Authorization: Bearer plt_...` agent keys and optional Cloudflare Zero Trust Service
 * Auth JWT / shared `X-Postlet-Service-Secret` verification.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { AgentKeyRecord, AgentScope } from "../../shared/types";
import type { PostletEnv, PostletVariables } from "../env";
import { timingSafeEqualStrings } from "../lib/crypto";
import { authenticateAgentKey, hasMinimumScope } from "../services/agent-keys";
import { extractAccessJwt, verifyCloudflareAccessJwt } from "./access-auth";
import { recordAuditLog } from "./audit";

function splitCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Extracts and validates optional Service Auth protections plus the `Authorization: Bearer plt_...`
 * token on agent routes.
 */
export function createAgentAuthMiddleware(
  accessFetchFn?: typeof fetch,
): MiddlewareHandler<{ Bindings: PostletEnv; Variables: PostletVariables }> {
  return async (c, next) => {
    const allowedServiceIds = splitCsv(c.env.CF_ACCESS_SERVICE_TOKEN_IDS);
    const serviceAudiences = splitCsv(c.env.CF_ACCESS_SERVICE_AUD);
    const requireCfServiceJwt = serviceAudiences.length > 0 || allowedServiceIds.length > 0;

    if (requireCfServiceJwt) {
      const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN?.trim();
      const targetAudiences =
        serviceAudiences.length > 0
          ? serviceAudiences
          : splitCsv(c.env.CF_ACCESS_AUD);

      if (!teamDomain || targetAudiences.length === 0) {
        return c.json(
          {
            error:
              "Cloudflare Zero Trust Service Auth is misconfigured (missing CF_ACCESS_TEAM_DOMAIN or AUD)",
          },
          401,
        );
      }

      const accessJwt = extractAccessJwt(c.req.raw);
      if (!accessJwt) {
        return c.json({ error: "Missing Cloudflare Zero Trust Service Auth token" }, 401);
      }

      let jwtPayload;
      try {
        jwtPayload = await verifyCloudflareAccessJwt(accessJwt, {
          teamDomain,
          audience: targetAudiences,
          fetchFn: accessFetchFn,
        });
      } catch (err) {
        console.error(
          JSON.stringify({
            message: "agent service auth jwt rejected",
            reason: err instanceof Error ? err.message : "JWT verification failed",
            path: new URL(c.req.url).pathname,
          }),
        );
        return c.json({ error: "Invalid Cloudflare Zero Trust Service Auth token" }, 401);
      }

      if (allowedServiceIds.length > 0) {
        const commonName = (jwtPayload.common_name ?? "").trim();
        let authorized = false;
        for (const allowedId of allowedServiceIds) {
          if (commonName && (await timingSafeEqualStrings(commonName, allowedId))) {
            authorized = true;
            break;
          }
        }
        if (!authorized) {
          return c.json({ error: "Cloudflare Access Service Token is not authorized" }, 403);
        }
      }
    }

    const sharedServiceSecret = c.env.POSTLET_SERVICE_AUTH_SECRET?.trim() ?? "";
    if (sharedServiceSecret) {
      const provided = c.req.header("X-Postlet-Service-Secret")?.trim() ?? "";
      if (!provided || !(await timingSafeEqualStrings(provided, sharedServiceSecret))) {
        return c.json({ error: "Invalid or missing X-Postlet-Service-Secret header" }, 401);
      }
    }

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
}

export const agentAuthMiddleware = createAgentAuthMiddleware();

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
