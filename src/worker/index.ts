/**
 * @file src/worker/index.ts
 * @description Main Cloudflare Worker entrypoint for Postlet. Mounts webhook ingestion,
 * signed self-hosted tracking routes, Streamable HTTP MCP server, scoped Agent REST API,
 * Zero-Trust-protected Admin Web API, health endpoint, Cloudflare Email Routing `email()` handler,
 * Email Sending event `queue()` consumer, and hourly Cron trigger for Daily Inbox Summaries.
 */

import { Hono } from "hono";
import { ensureDatabaseSchema } from "./db/bootstrap";
import type { PostletEnv, PostletVariables } from "./env";
import { createAdminRoutes } from "./routes/admin";
import { createAgentV1Routes } from "./routes/agent-v1";
import { createMcpRoutes } from "./routes/mcp";
import { createTrackingRoutes } from "./routes/tracking";
import { createWebhookRoutes } from "./routes/webhooks";
import { runScheduledDailySummaryCheck } from "./services/ai-functions";
import { handleCloudflareInboundEmail } from "./services/inbound-cloudflare";
import { applyDeliveryWebhookEvent } from "./services/mail";
import {
  createMailTransport,
  mapCloudflareQueueEventToDeliveryEvent,
} from "./services/transports";

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
      version: c.env.APP_VERSION || "0.5.1",
    });
  });

  app.route("/t", createTrackingRoutes());
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
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  /**
   * Cloudflare Email Routing inbound handler (`email()`): parses raw MIME streams via `postal-mime`,
   * stores attachments in R2, persists messages in D1 for free, and runs optional AI automation.
   */
  async email(
    message: ForwardableEmailMessage,
    env: PostletEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    const result = await handleCloudflareInboundEmail(message, env, ctx);
    console.log(
      JSON.stringify({
        message: "processed cloudflare email routing inbound",
        to: message.to,
        created: result.created,
        ignored: result.ignored,
        threadId: result.threadId ?? null,
      }),
    );
  },

  /**
   * Cloudflare Email Service event queue consumer (`queue()`): applies delivery, bounce, defer,
   * and complaint statuses emitted asynchronously by Cloudflare Email Sending.
   */
  async queue(
    batch: MessageBatch<unknown>,
    env: PostletEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await ensureDatabaseSchema(env.DB);
    for (const msg of batch.messages) {
      const mapped = mapCloudflareQueueEventToDeliveryEvent(msg.body);
      if (mapped) {
        await applyDeliveryWebhookEvent(
          env.DB,
          mapped.eventType,
          {
            email_id: mapped.email_id,
            ...(mapped.reason ? { reason: mapped.reason } : {}),
          },
          mapped.timestamp,
        );
      }
      msg.ack();
    }
  },

  /**
   * Hourly Cloudflare Cron trigger evaluating whether the built-in Cloudflare AI agent
   * should generate today's Daily Inbox Summary for the owner's configured hour and timezone.
   */
  async scheduled(
    _controller: ScheduledController,
    env: PostletEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    const transport = createMailTransport(env);
    const task = (async () => {
      await ensureDatabaseSchema(env.DB);
      const res = await runScheduledDailySummaryCheck(env.DB, env, transport);
      console.log(JSON.stringify({ message: "scheduled daily summary check", ...res }));
    })();
    ctx.waitUntil(task);
  },
} satisfies ExportedHandler<PostletEnv>;
