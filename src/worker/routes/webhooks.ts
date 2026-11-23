/**
 * @file src/worker/routes/webhooks.ts
 * @description Provider webhook receivers handling Resend (`email.received` & delivery/tracking
 * webhooks via Svix HMAC-SHA256) and Amazon SES / SNS (`POST /api/webhooks/ses` via X.509 RSA
 * signature verification and trusted `sns.*.amazonaws.com` certificate validation).
 */

import { Hono } from "hono";
import type { PostletEnv, PostletVariables } from "../env";
import { timingSafeEqualStrings } from "../lib/crypto";
import { getSettings } from "../services/addresses";
import { triageThread } from "../services/ai";
import { evaluateAndRunImportantAutoReply } from "../services/ai-functions";
import {
  applyDeliveryWebhookEvent,
  ingestInboundEmail,
  type InboundWebhookData,
} from "../services/mail";
import { ResendClient, verifyResendWebhookSignature } from "../services/resend";
import { getSelfHostedTrackingConfig } from "../services/tracking";
import { createMailTransport } from "../services/transports";
import {
  isTrustedSnsUrl,
  parseSesSnsNotification,
  type SnsMessageEnvelope,
  verifySnsSignature,
} from "../services/transports/ses-transport";

interface ResendWebhookEnvelope {
  type: string;
  created_at?: string;
  data: Record<string, unknown>;
}

/**
 * Safely delegates background promises to `ctx.waitUntil` when an ExecutionContext is active,
 * falling back to awaiting directly in isolated unit-test invocations without `ctx`.
 */
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

export function createWebhookRoutes(resendFetchFn?: typeof fetch) {
  const router = new Hono<{ Bindings: PostletEnv; Variables: PostletVariables }>();

  router.post("/resend", async (c) => {
    const rawBody = await c.req.text();
    const secret = c.env.RESEND_WEBHOOK_SECRET ?? "";
    const valid = await verifyResendWebhookSignature(rawBody, c.req.raw.headers, secret);

    if (!valid) {
      console.error(
        JSON.stringify({
          message: "resend webhook signature verification failed",
          svixId: c.req.header("svix-id") ?? null,
        }),
      );
      return c.json({ error: "Invalid webhook signature" }, 401);
    }

    let payload: ResendWebhookEnvelope;
    try {
      payload = JSON.parse(rawBody) as ResendWebhookEnvelope;
    } catch {
      return c.json({ error: "Malformed JSON webhook body" }, 400);
    }

    if (!payload?.type || !payload?.data) {
      return c.json({ error: "Missing event type or data" }, 400);
    }

    const resendClient = new ResendClient(c.env.RESEND_API_KEY ?? "", resendFetchFn);

    if (payload.type === "email.received") {
      const inboundData = payload.data as unknown as InboundWebhookData;
      const result = await ingestInboundEmail(
        c.env.DB,
        c.env.ATTACHMENTS,
        resendClient,
        inboundData,
        c.env.MAIL_DOMAIN ?? "",
      );

      console.log(
        JSON.stringify({
          message: "processed email.received webhook",
          emailId: inboundData.email_id,
          created: result.created,
          ignored: result.ignored,
          threadId: result.threadId ?? null,
        }),
      );

      if (result.created && result.threadId) {
        const settings = await getSettings(
          c.env.DB,
          c.env.MAIL_DOMAIN ?? "",
          c.env.DEFAULT_AI_MODEL,
        );

        // Built-in Cloudflare AI automation ONLY executes when explicitly enabled in Settings.
        if (
          settings.aiEnabled &&
          (settings.aiAutoTriageEnabled || settings.aiImportantAutoReplyEnabled)
        ) {
          const threadId = result.threadId;
          const transport = createMailTransport(c.env, resendFetchFn);
          const trackingConfig = getSelfHostedTrackingConfig(c.env);
          const aiTask = (async () => {
            try {
              if (settings.aiAutoTriageEnabled) {
                await triageThread(c.env.DB, c.env, threadId, {
                  actorType: "postlet_ai",
                  actorLabel: "postlet-ai",
                });
              }
              if (settings.aiImportantAutoReplyEnabled) {
                await evaluateAndRunImportantAutoReply(
                  c.env.DB,
                  c.env.ATTACHMENTS,
                  c.env,
                  transport,
                  threadId,
                  {
                    callerType: "webhook",
                    actorLabel: "postlet-ai:auto-reply",
                  },
                  trackingConfig,
                );
              }
            } catch (err) {
              console.error(
                JSON.stringify({
                  message: "postlet-ai background inbound task failed",
                  threadId,
                  error: err instanceof Error ? err.message : String(err),
                }),
              );
            }
          })();

          await scheduleBackground(c, aiTask);
        }
      }

      return c.json({ ok: true, ...result }, 200);
    }

    if (
      [
        "email.sent",
        "email.delivered",
        "email.delivery_delayed",
        "email.bounced",
        "email.complained",
        "email.opened",
        "email.clicked",
      ].includes(payload.type)
    ) {
      const updateResult = await applyDeliveryWebhookEvent(
        c.env.DB,
        payload.type,
        payload.data as {
          email_id?: string;
          bounce?: { message?: string; subType?: string; type?: string };
          reason?: string;
          click?: { link?: string; ipAddress?: string; timestamp?: string };
        },
        payload.created_at,
      );

      console.log(
        JSON.stringify({
          message: "processed delivery webhook",
          eventType: payload.type,
          updated: updateResult.updated,
          messageId: updateResult.messageId ?? null,
        }),
      );

      return c.json({ ok: true, ...updateResult }, 200);
    }

    return c.json({ ok: true, ignored: true, eventType: payload.type }, 200);
  });

  // Amazon SES -> SNS webhook receiver (Delivery, Bounce, Complaint, DeliveryDelay, Open, Click).
  router.post("/ses", async (c) => {
    const sharedSecret = c.env.SES_WEBHOOK_SECRET?.trim() ?? "";
    if (sharedSecret) {
      const provided =
        c.req.header("x-postlet-webhook-secret")?.trim() ||
        c.req.query("secret")?.trim() ||
        "";
      if (!provided || !(await timingSafeEqualStrings(provided, sharedSecret))) {
        return c.json({ error: "Invalid SES webhook secret" }, 401);
      }
    }

    const rawBody = await c.req.text();
    let snsMsg: SnsMessageEnvelope;
    try {
      snsMsg = JSON.parse(rawBody) as SnsMessageEnvelope;
    } catch {
      return c.json({ error: "Malformed JSON SNS payload" }, 400);
    }

    const allowedTopicArn = c.env.SES_SNS_TOPIC_ARN?.trim();
    if (allowedTopicArn && snsMsg.TopicArn !== allowedTopicArn) {
      return c.json({ error: "SNS TopicArn mismatch" }, 403);
    }

    const sigValid = await verifySnsSignature(snsMsg, resendFetchFn);
    if (!sigValid) {
      console.error(
        JSON.stringify({
          message: "sns signature verification failed",
          type: snsMsg?.Type ?? null,
          topicArn: snsMsg?.TopicArn ?? null,
        }),
      );
      return c.json({ error: "Invalid SNS signature" }, 401);
    }

    const safeFetch: typeof fetch =
      !resendFetchFn || resendFetchFn === globalThis.fetch
        ? (input, init) => globalThis.fetch(input, init)
        : (input, init) => resendFetchFn(input, init);

    if (snsMsg.Type === "SubscriptionConfirmation") {
      if (snsMsg.SubscribeURL && isTrustedSnsUrl(snsMsg.SubscribeURL)) {
        const confirmRes = await safeFetch(snsMsg.SubscribeURL, { method: "GET" });
        return c.json({ ok: confirmRes.ok, subscribed: true }, 200);
      }
      return c.json({ error: "Invalid SubscribeURL" }, 400);
    }

    if (snsMsg.Type === "Notification" && snsMsg.Message) {
      const parsedEvent = parseSesSnsNotification(snsMsg.Message);
      if (!parsedEvent) {
        return c.json({ ok: true, ignored: true }, 200);
      }
      const updateResult = await applyDeliveryWebhookEvent(
        c.env.DB,
        parsedEvent.eventType,
        parsedEvent.eventData,
        parsedEvent.timestamp,
      );
      return c.json({ ok: true, ...updateResult }, 200);
    }

    return c.json({ ok: true, ignored: true, type: snsMsg.Type }, 200);
  });

  return router;
}
