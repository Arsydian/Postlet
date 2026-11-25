/**
 * @file tests/email-images.test.ts
 * @description Regression tests verifying remote signature image rewriting/blocking, inline CID
 * attachment resolution, per-message "Allow images" persistence, and trusted sender settings.
 */

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AdminMetaResponse, AttachmentRecord, ThreadDetail } from "../src/shared/types";
import {
  buildEmailIframeSrcDoc,
  hasRemoteImages,
  matchCidAttachments,
  normalizeContentId,
  prepareEmailHtmlForIframe,
} from "../src/client/lib/sanitize";
import { createApp } from "../src/worker/index";
import { createAddress } from "../src/worker/services/addresses";
import { ingestInboundEmail } from "../src/worker/services/mail";
import { ResendClient } from "../src/worker/services/resend";
import {
  buildTestEnv,
  createMockResendFetch,
  resetDatabaseAndStorage,
} from "./helpers/test-env";

function makeAttachment(overrides: Partial<AttachmentRecord>): AttachmentRecord {
  return {
    id: "att-1",
    messageId: "msg-1",
    resendAttachmentId: null,
    r2Key: "attachments/msg-1/att-1/logo.png",
    filename: "logo.png",
    contentType: "image/png",
    contentDisposition: "inline",
    contentId: "<img001@cid>",
    sizeBytes: 1024,
    createdAt: "2026-11-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("Email Signature & Inline Image Handling", () => {
  beforeEach(async () => {
    await resetDatabaseAndStorage();
  });

  it("detects remote images, normalizes Content-IDs, and filters safe CID raster attachments", () => {
    const signatureHtml = `
      <table><tr><td>
        <a href="https://partner.org/">
          <img alt="photo" height="50" src="https://cdn.partner.org/logo.jpg" width="50">
        </a>
        <img src="cid:img001@cid" alt="Sig Badge">
        <img src="cid:xss-svg@cid" alt="SVG">
        <img src="cid:huge-png@cid" alt="Huge">
      </td></tr></table>
    `;

    expect(hasRemoteImages(signatureHtml)).toBe(true);
    expect(hasRemoteImages('<img src="data:image/png;base64,AAAA">')).toBe(false);
    expect(hasRemoteImages('<img src="cid:img001@cid">')).toBe(false);

    expect(normalizeContentId("  cid:<Img001@cid>  ")).toBe("img001@cid");
    expect(normalizeContentId("<Badge%2001@CID>")).toBe("badge 01@cid");

    const matches = matchCidAttachments(signatureHtml, [
      makeAttachment({ id: "safe-png", contentId: "<img001@cid>", contentType: "image/png" }),
      makeAttachment({ id: "unsafe-svg", contentId: "<xss-svg@cid>", contentType: "image/svg+xml" }),
      makeAttachment({
        id: "too-large",
        contentId: "<huge-png@cid>",
        contentType: "image/png",
        sizeBytes: 6 * 1024 * 1024,
      }),
    ]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.cidKey).toBe("img001@cid");
    expect(matches[0]?.attachment.id).toBe("safe-png");
  });

  it("hides blocked remote images cleanly while resolving CID images, and restores src when allowed", () => {
    const html = [
      '<p>Signature below:</p>',
      '<img alt="photo" height="50" src="https://example.com/logo.jpg" width="50">',
      '<img alt="inline" src="cid:badge@example.com">',
      '<img alt="missing" src="cid:missing@example.com">',
      '<img alt="data" src="data:image/png;base64,iVBORw0KGgo=">',
    ].join("");

    const cidDataUris = new Map<string, string>([
      ["badge@example.com", "data:image/png;base64,iVBORw0KGgo="],
    ]);

    const blockedDoc = buildEmailIframeSrcDoc(html, {
      allowRemoteImages: false,
      cidDataUris,
    });
    expect(blockedDoc).toContain("img-src data:;");
    expect(blockedDoc).toContain("img.postlet-blocked-img { display: none !important; }");
    expect(blockedDoc).not.toContain("https://example.com/logo.jpg");
    expect(blockedDoc).toContain('alt="photo"');
    expect(blockedDoc).toContain('class="postlet-blocked-img"');
    expect(blockedDoc).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(blockedDoc).not.toContain("cid:badge@example.com");
    expect(blockedDoc).not.toContain("cid:missing@example.com");

    const allowedBody = prepareEmailHtmlForIframe(html, {
      allowRemoteImages: true,
      cidDataUris,
    });
    expect(allowedBody).toContain(
      '<img alt="photo" height="50" src="https://example.com/logo.jpg" width="50">',
    );
    expect(allowedBody).toContain('src="data:image/png;base64,iVBORw0KGgo="');

    const allowedDoc = buildEmailIframeSrcDoc(html, {
      allowRemoteImages: true,
      cidDataUris,
    });
    expect(allowedDoc).toContain("img-src https: http: data:;");
    expect(allowedDoc).toContain(
      '<img alt="photo" height="50" src="https://example.com/logo.jpg" width="50">',
    );
  });

  it("persists per-message image allowance in D1 and normalizes trustedImageSenders in settings", async () => {
    await createAddress(env.DB, { email: "me@mail.example.com", isDefault: true });

    const mockResend = createMockResendFetch({
      receivedEmails: {
        em_sig: {
          id: "em_sig",
          from: "Sender <sender@partner.org>",
          to: ["me@mail.example.com"],
          subject: "Hello with signature logo",
          text: "Hello",
          html: '<p>Hello</p><img src="https://cdn.partner.org/logo.png" width="50" height="50">',
        },
      },
    });
    const resendClient = new ResendClient("re_test", mockResend.fetchFn);
    const ingested = await ingestInboundEmail(env.DB, env.ATTACHMENTS, resendClient, {
      email_id: "em_sig",
      from: "Sender <sender@partner.org>",
      to: ["me@mail.example.com"],
    });

    const app = createApp({ resendFetchFn: mockResend.fetchFn });
    const testEnv = buildTestEnv();

    // Missing CSRF header -> 403
    const noCsrfRes = await app.fetch(
      new Request(`http://localhost/api/admin/messages/${ingested.messageId}/preferences`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowRemoteImages: true }),
      }),
      testEnv,
    );
    expect(noCsrfRes.status).toBe(403);

    // Unknown message ID -> 404
    const notFoundRes = await app.fetch(
      new Request("http://localhost/api/admin/messages/nonexistent-msg/preferences", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Postlet-CSRF": "1",
        },
        body: JSON.stringify({ allowRemoteImages: true }),
      }),
      testEnv,
    );
    expect(notFoundRes.status).toBe(404);

    // Enable remote images for this message
    const allowRes = await app.fetch(
      new Request(`http://localhost/api/admin/messages/${ingested.messageId}/preferences`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Postlet-CSRF": "1",
        },
        body: JSON.stringify({ allowRemoteImages: true }),
      }),
      testEnv,
    );
    expect(allowRes.status).toBe(200);
    const allowJson = (await allowRes.json()) as {
      message: { headers: Record<string, string> };
    };
    expect(allowJson.message.headers["x-postlet-allow-images"]).toBe("true");

    // Re-fetching the thread preserves x-postlet-allow-images
    const threadRes = await app.fetch(
      new Request(`http://localhost/api/admin/threads/${ingested.threadId}`),
      testEnv,
    );
    expect(threadRes.status).toBe(200);
    const threadJson = (await threadRes.json()) as { thread: ThreadDetail };
    expect(threadJson.thread.messages[0]?.headers["x-postlet-allow-images"]).toBe("true");

    // Turning it back off deletes the header cleanly
    const revokeRes = await app.fetch(
      new Request(`http://localhost/api/admin/messages/${ingested.messageId}/preferences`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Postlet-CSRF": "1",
        },
        body: JSON.stringify({ allowRemoteImages: false }),
      }),
      testEnv,
    );
    expect(revokeRes.status).toBe(200);
    const revokeJson = (await revokeRes.json()) as {
      message: { headers: Record<string, string> };
    };
    expect(revokeJson.message.headers["x-postlet-allow-images"]).toBeUndefined();

    // Update trustedImageSenders -> normalized & deduplicated in settings and meta
    const settingsRes = await app.fetch(
      new Request("http://localhost/api/admin/settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Postlet-CSRF": "1",
        },
        body: JSON.stringify({
          trustedImageSenders: [
            "  Sender@Partner.ORG ",
            "sender@partner.org",
            "alerts@example.com",
          ],
        }),
      }),
      testEnv,
    );
    expect(settingsRes.status).toBe(200);
    const settingsJson = (await settingsRes.json()) as {
      settings: { trustedImageSenders: string[] };
    };
    expect(settingsJson.settings.trustedImageSenders).toEqual([
      "sender@partner.org",
      "alerts@example.com",
    ]);

    const metaRes = await app.fetch(new Request("http://localhost/api/admin/meta"), testEnv);
    expect(metaRes.status).toBe(200);
    const metaJson = (await metaRes.json()) as AdminMetaResponse;
    expect(metaJson.settings.trustedImageSenders).toEqual([
      "sender@partner.org",
      "alerts@example.com",
    ]);
  });
});
