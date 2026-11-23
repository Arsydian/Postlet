/**
 * @file src/worker/routes/tracking.ts
 * @description Public HMAC-signed open pixel (`/t/o/:token.gif`) and click-redirect (`/t/c/:token`)
 * endpoints enabling provider-agnostic engagement tracking in Postlet.
 */

import { Hono } from "hono";
import type { PostletEnv, PostletVariables } from "../env";
import { recordEngagementByMessageId } from "../services/mail";
import { TRANSPARENT_GIF_BYTES, verifyTrackingToken } from "../services/tracking";

async function scheduleBackground(
  c: { executionCtx: { waitUntil(promise: Promise<unknown>): void } },
  task: Promise<unknown>,
): Promise<void> {
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    await task;
  }
}

export function createTrackingRoutes() {
  const router = new Hono<{ Bindings: PostletEnv; Variables: PostletVariables }>();

  router.get("/o/:token", async (c) => {
    const rawToken = c.req.param("token").replace(/\.gif$/i, "");
    const secret = c.env.TRACKING_SECRET?.trim() ?? "";
    const payload = secret ? await verifyTrackingToken(rawToken, secret) : null;

    if (payload && payload.t === "o") {
      await scheduleBackground(
        c,
        recordEngagementByMessageId(c.env.DB, payload.m, "email.opened").catch(() => undefined),
      );
    }

    return new Response(TRANSPARENT_GIF_BYTES, {
      status: 200,
      headers: {
        "Content-Type": "image/gif",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    });
  });

  router.get("/c/:token", async (c) => {
    const secret = c.env.TRACKING_SECRET?.trim() ?? "";
    if (!secret) {
      return c.json({ error: "Tracking is not configured" }, 404);
    }

    const payload = await verifyTrackingToken(c.req.param("token"), secret);
    if (!payload || payload.t !== "c" || !payload.u) {
      return c.json({ error: "Invalid or tampered tracking link" }, 403);
    }

    let target: URL;
    try {
      target = new URL(payload.u);
    } catch {
      return c.json({ error: "Invalid redirect target" }, 400);
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      return c.json({ error: "Unsupported redirect URL scheme" }, 400);
    }

    await scheduleBackground(
      c,
      recordEngagementByMessageId(c.env.DB, payload.m, "email.clicked", target.href).catch(
        () => undefined,
      ),
    );

    return c.redirect(target.href, 302);
  });

  return router;
}
