/**
 * @file src/worker/services/tracking.ts
 * @description Provider-agnostic self-hosted open & link click tracking using HMAC-SHA256 signed
 * URL tokens, enabling tracking across Resend, Cloudflare Email Sending, and Amazon SES.
 */

import type { PostletEnv } from "../env";
import { decodeBase64UrlText, encodeBase64Url, timingSafeEqualStrings } from "../lib/crypto";

const textEncoder = new TextEncoder();

export interface SelfHostedTrackingConfig {
  baseUrl: string;
  secret: string;
}

export interface TrackingTokenPayload {
  /** Event kind: `'o'` = open pixel, `'c'` = link click. */
  t: "o" | "c";
  /** Local Postlet `messages.id`. */
  m: string;
  /** Target HTTP(S) URL for click redirects (`t === 'c'`). */
  u?: string;
}

/** Standard 43-byte transparent 1x1 GIF binary returned by `/t/o/:token.gif`. */
export const TRANSPARENT_GIF_BYTES = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff,
  0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

/**
 * Extracts validated self-hosted tracking configuration when both `TRACKING_BASE_URL` and
 * `TRACKING_SECRET` are configured.
 */
export function getSelfHostedTrackingConfig(
  env: Pick<PostletEnv, "TRACKING_BASE_URL" | "TRACKING_SECRET">,
): SelfHostedTrackingConfig | undefined {
  const rawBase = env.TRACKING_BASE_URL?.trim() ?? "";
  const secret = env.TRACKING_SECRET?.trim() ?? "";
  if (!rawBase || !secret) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(rawBase);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return undefined;
  }
  return {
    baseUrl: rawBase.replace(/\/+$/, ""),
    secret,
  };
}

export function isSelfHostedTrackingConfigured(
  env: Pick<PostletEnv, "TRACKING_BASE_URL" | "TRACKING_SECRET">,
): boolean {
  return Boolean(getSelfHostedTrackingConfig(env));
}

async function computeHmacSignature(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(data));
  return encodeBase64Url(new Uint8Array(sig));
}

/**
 * Serializes and HMAC-SHA256 signs a tracking payload into `<b64url>.<sig>`.
 */
export async function signTrackingToken(
  payload: TrackingTokenPayload,
  secret: string,
): Promise<string> {
  const encoded = encodeBase64Url(JSON.stringify(payload));
  const sig = await computeHmacSignature(encoded, secret);
  return `${encoded}.${sig}`;
}

/**
 * Verifies a signed tracking token using constant-time comparison and validates its structure.
 */
export async function verifyTrackingToken(
  rawToken: string,
  secret: string,
): Promise<TrackingTokenPayload | null> {
  if (!rawToken || !secret) return null;
  const dotIdx = rawToken.indexOf(".");
  if (dotIdx <= 0) return null;

  const encoded = rawToken.slice(0, dotIdx);
  const providedSig = rawToken.slice(dotIdx + 1);
  if (!encoded || !providedSig) return null;

  const expectedSig = await computeHmacSignature(encoded, secret);
  if (!(await timingSafeEqualStrings(providedSig, expectedSig))) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeBase64UrlText(encoded)) as Partial<TrackingTokenPayload>;
    if ((parsed.t !== "o" && parsed.t !== "c") || typeof parsed.m !== "string" || !parsed.m) {
      return null;
    }
    if (parsed.t === "c" && (typeof parsed.u !== "string" || !parsed.u)) {
      return null;
    }
    return parsed as TrackingTokenPayload;
  } catch {
    return null;
  }
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plainTextToTrackingHtml(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "<p></p>";
  return normalized
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtmlAttr(para).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

/**
 * Rewrites HTTP(S) anchor links inside an HTML email to signed `/t/c/:token` redirects and
 * embeds a signed 1x1 transparent `/t/o/:token.gif` open pixel. Plain-text-only messages are
 * automatically promoted to clean `<p>` HTML first so tracking works uniformly across providers.
 */
export async function instrumentHtmlWithSelfHostedTracking(
  htmlBody: string,
  textBody: string,
  options: {
    messageId: string;
    baseUrl: string;
    secret: string;
  },
): Promise<string> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const sourceHtml = htmlBody.trim() ? htmlBody : plainTextToTrackingHtml(textBody);

  // Collect all HTTP(S) links first so async Web Crypto signing stays clean and linear.
  const anchorHrefRegex = /(<a\b[^>]*\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi;
  const matches: Array<{ full: string; prefix: string; quote: string; rawHref: string }> = [];
  for (const m of sourceHtml.matchAll(anchorHrefRegex)) {
    matches.push({ full: m[0], prefix: m[1], quote: m[2], rawHref: m[3] });
  }

  let rewrittenHtml = sourceHtml;
  if (matches.length > 0) {
    const parts: string[] = [];
    let cursor = 0;
    for (const m of sourceHtml.matchAll(anchorHrefRegex)) {
      const idx = m.index ?? 0;
      parts.push(sourceHtml.slice(cursor, idx));
      cursor = idx + m[0].length;

      const decodedUrl = m[3].replace(/&amp;/gi, "&").trim();
      if (decodedUrl.startsWith(`${baseUrl}/t/`)) {
        parts.push(m[0]);
      } else {
        let validHttp = false;
        try {
          const parsed = new URL(decodedUrl);
          validHttp = parsed.protocol === "https:" || parsed.protocol === "http:";
        } catch {
          validHttp = false;
        }
        if (validHttp) {
          const clickToken = await signTrackingToken(
            { t: "c", m: options.messageId, u: decodedUrl },
            options.secret,
          );
          const trackedHref = `${baseUrl}/t/c/${clickToken}`;
          parts.push(`${m[1]}${m[2]}${trackedHref}${m[2]}`);
        } else {
          parts.push(m[0]);
        }
      }
    }
    parts.push(sourceHtml.slice(cursor));
    rewrittenHtml = parts.join("");
  }

  const openToken = await signTrackingToken({ t: "o", m: options.messageId }, options.secret);
  const pixelTag = `<img src="${escapeHtmlAttr(`${baseUrl}/t/o/${openToken}.gif`)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0;" />`;

  if (/<\/body>/i.test(rewrittenHtml)) {
    return rewrittenHtml.replace(/<\/body>/i, `${pixelTag}</body>`);
  }
  return `${rewrittenHtml}\n${pixelTag}`;
}
