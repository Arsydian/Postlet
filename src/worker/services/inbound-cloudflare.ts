/**
 * @file src/worker/services/inbound-cloudflare.ts
 * @description Cloudflare Email Routing inbound `email()` handler using `postal-mime` to parse
 * raw RFC 5322 MIME streams and ingest messages + attachments into Postlet's D1 and R2 for free.
 */

import PostalMime, { type Address } from "postal-mime";
import { ensureDatabaseSchema } from "../db/bootstrap";
import type { PostletEnv } from "../env";
import { sha256Hex } from "../lib/crypto";
import { getSettings } from "./addresses";
import { triageThread } from "./ai";
import { evaluateAndRunImportantAutoReply } from "./ai-functions";
import { ingestDirectInboundEmail, type IngestInboundResult } from "./mail";
import { getSelfHostedTrackingConfig } from "./tracking";
import { createMailTransport } from "./transports";

const MAX_INBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const textEncoder = new TextEncoder();

function flattenMimeAddresses(
  list: Address[] | undefined,
): string[] {
  if (!list || list.length === 0) return [];
  const out: string[] = [];
  for (const item of list) {
    if (item.group) {
      for (const member of item.group) {
        if (member.address) out.push(member.address.trim().toLowerCase());
      }
    } else if (item.address) {
      out.push(item.address.trim().toLowerCase());
    }
  }
  return Array.from(new Set(out));
}

function attachmentContentToBytes(
  content: ArrayBuffer | Uint8Array | string,
  encoding?: "base64" | "utf8",
): Uint8Array {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  if (encoding === "base64") {
    const bin = atob(content);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }
  return textEncoder.encode(content);
}

/**
 * Processes an incoming email delivered to Postlet's Worker via Cloudflare Email Routing.
 * Parses the single-use `message.raw` stream with `postal-mime`, stores attachments in R2,
 * persists the thread/message in D1, and triggers optional background Workers AI triage/reply.
 */
export async function handleCloudflareInboundEmail(
  message: ForwardableEmailMessage,
  env: PostletEnv,
  ctx?: Pick<ExecutionContext, "waitUntil">,
  options?: { fetchFn?: typeof fetch },
): Promise<IngestInboundResult> {
  await ensureDatabaseSchema(env.DB);

  // `message.raw` is a single-use stream — buffer once into an ArrayBuffer before parsing.
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(rawBuffer);

  const headerMap: Record<string, string> = {};
  if (typeof message.headers?.forEach === "function") {
    message.headers.forEach((val, key) => {
      headerMap[key.toLowerCase()] = val;
    });
  }
  for (const h of parsed.headers) {
    if (h.key && !(h.key.toLowerCase() in headerMap)) {
      headerMap[h.key.toLowerCase()] = h.value;
    }
  }
  if (parsed.inReplyTo && !headerMap["in-reply-to"]) {
    headerMap["in-reply-to"] = parsed.inReplyTo;
  }
  if (parsed.references && !headerMap["references"]) {
    headerMap["references"] = parsed.references;
  }

  const envelopeFrom = (message.from || "").trim().toLowerCase();
  const envelopeTo = (message.to || "").trim().toLowerCase();
  const parsedFromMailbox =
    parsed.from && !parsed.from.group && parsed.from.address ? parsed.from : null;

  const toAddresses = Array.from(
    new Set([envelopeTo, ...flattenMimeAddresses(parsed.to)].filter(Boolean)),
  );
  const ccAddresses = flattenMimeAddresses(parsed.cc);
  const bccAddresses = flattenMimeAddresses(parsed.bcc);
  const replyToList = flattenMimeAddresses(parsed.replyTo);

  const rfcMessageId =
    parsed.messageId?.trim() || message.headers?.get("message-id")?.trim() || null;
  const dedupeMaterial = rfcMessageId
    ? `${rfcMessageId}|${envelopeTo}`
    : `${envelopeFrom}|${envelopeTo}|${parsed.subject ?? ""}|${parsed.date ?? rawBuffer.byteLength}`;
  const providerMessageId = `cf_${await sha256Hex(dedupeMaterial)}`;

  const attachments = (parsed.attachments ?? [])
    .map((att) => {
      const data = attachmentContentToBytes(att.content, att.encoding);
      if (data.byteLength > MAX_INBOUND_ATTACHMENT_BYTES) {
        throw new Error(`Inbound attachment ${att.filename ?? ""} exceeds 25 MB safety limit`);
      }
      return {
        filename: att.filename || "attachment.bin",
        contentType: att.mimeType || "application/octet-stream",
        contentDisposition: att.disposition || "attachment",
        contentId: att.contentId ?? null,
        data,
      };
    });

  const result = await ingestDirectInboundEmail(env.DB, env.ATTACHMENTS, {
    providerMessageId,
    fromAddress: parsedFromMailbox?.address || envelopeFrom,
    fromName: parsedFromMailbox?.name || "",
    toAddresses,
    ccAddresses,
    bccAddresses,
    replyTo: replyToList[0] ?? null,
    subject: parsed.subject ?? message.headers?.get("subject") ?? "(no subject)",
    textBody: parsed.text ?? "",
    htmlBody: parsed.html ?? "",
    headers: headerMap,
    rfcMessageId,
    createdAt: parsed.date || new Date().toISOString(),
    attachments,
    envMailDomain: env.MAIL_DOMAIN ?? "",
  });

  if (result.created && result.threadId) {
    const settings = await getSettings(env.DB, env.MAIL_DOMAIN ?? "", env.DEFAULT_AI_MODEL);
    if (
      settings.aiEnabled &&
      (settings.aiAutoTriageEnabled || settings.aiImportantAutoReplyEnabled)
    ) {
      const threadId = result.threadId;
      const transport = createMailTransport(env, options?.fetchFn);
      const trackingConfig = getSelfHostedTrackingConfig(env);
      const aiTask = (async () => {
        try {
          if (settings.aiAutoTriageEnabled) {
            await triageThread(env.DB, env, threadId, {
              actorType: "postlet_ai",
              actorLabel: "postlet-ai",
            });
          }
          if (settings.aiImportantAutoReplyEnabled) {
            await evaluateAndRunImportantAutoReply(
              env.DB,
              env.ATTACHMENTS,
              env,
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
              message: "postlet-ai background cf email task failed",
              threadId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      })();

      if (ctx) {
        ctx.waitUntil(aiTask);
      } else {
        await aiTask;
      }
    }
  }

  return result;
}
