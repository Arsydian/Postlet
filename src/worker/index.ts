/**
 * @file src/worker/index.ts
 * @description Main Cloudflare Worker entrypoint for Postlet. Mounts webhook ingestion,
 * Streamable HTTP MCP server, scoped Agent REST API, Zero-Trust-protected Admin Web API,
 * health endpoint, and hourly Cron trigger for Daily Inbox Summaries.
 */

import { Hono } from "hono";
import { ensureDatabaseSchema } from "./db/bootstrap";
import type { PostletEnv, PostletVariables } from "./env";
import { createAdminRoutes } from "./routes/admin";
import { createAgentV1Routes } from "./routes/agent-v1";
import { createMcpRoutes } from "./routes/mcp";
import { createWebhookRoutes } from "./routes/webhooks";
import { runScheduledDailySummaryCheck } from "./services/ai-functions";
import { ResendClient } from "./services/resend";

export interface CreateAppOptions {
  accessFetchFn?: typeof fetch;
  resendFetchFn?: typeof fetch;
}

/**
 * Constructs the Hono Worker application. Accepting optional fetch implementations enables
 * deterministic integration testing inside `@cloudflare/vitest-plugin` without live network calls.
 */
export function createApp(options?: CreateAppOptions) {
  const app = new Hono<{ Bindings: PostletEnv; Variables: PostletVariables }>();

  // Global security headers on every Worker response.
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });

  // Automatically bootstrap the D1 schema once per isolate cold start if the database
  // was freshly auto-provisioned and D1 migrations have not yet been applied.
  app.use("*", async (c, next) => {
    if (c.req.path !== "/api/health" && c.env.DB) {
      await ensureDatabaseSchema(c.env.DB);
    }
    await next();
  });

  app.get("/api/health", (c) => {
    return c.json({
      ok: true,
      service: c.env.APP_NAME || "Postlet",
      version: c.env.APP_VERSION || "0.1.3",
    });
  });

  app.route("/api/webhooks", createWebhookRoutes(options?.resendFetchFn));
  app.route("/mcp", createMcpRoutes(options?.resendFetchFn));
  app.route("/api/v1", createAgentV1Routes(options?.resendFetchFn));
  app.route("/api/admin", createAdminRoutes(options));

  app.notFound((c) => {
    return c.json({ error: "Endpoint not found" }, 404);
  });

  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error(
      JSON.stringify({
        message: "unhandled worker error",
        path: new URL(c.req.url).pathname,
        error: message,
      }),
    );
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,

  /**
   * Hourly Cloudflare Cron trigger evaluating whether the built-in Cloudflare AI agent
   * should generate today's Daily Inbox Summary for the owner's configured hour and timezone.
   */
  async scheduled(
    _controller: ScheduledController,
    env: PostletEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    const resendClient = new ResendClient(env.RESEND_API_KEY ?? "");
    const task = (async () => {
      await ensureDatabaseSchema(env.DB);
      const res = await runScheduledDailySummaryCheck(env.DB, env, resendClient);
      console.log(JSON.stringify({ message: "scheduled daily summary check", ...res }));
    })();
    ctx.waitUntil(task);
  },
} satisfies ExportedHandler<PostletEnv>;
