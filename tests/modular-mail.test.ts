/**
 * @file tests/modular-mail.test.ts
 * @description Tests Postlet v0.5.0 modular mail capabilities: free Cloudflare Email Routing
 * inbound (`email()` + `postal-mime` + R2 attachments), multi-domain unified & scoped inboxes,
 * multi-domain RFC 3834 loop protection, Cloudflare `send_email` + `queue()` delivery updates,
 * Amazon SES v2 SigV4 + X.509 SNS webhooks, and self-hosted `/t/*` open & click tracking.
 */

import { env } from "cloudflare:workers";
import PostalMime from "postal-mime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminMetaResponse, ThreadSummary } from "../src/shared/types";
import worker, { createApp } from "../src/worker/index";
import { bytesToBase64 } from "../src/worker/lib/crypto";
import { createAddress, updateSettings } from "../src/worker/services/addresses";
import { checkAutoReplySafety } from "../src/worker/services/ai-functions";
import { handleCloudflareInboundEmail } from "../src/worker/services/inbound-cloudflare";
import { getDomainUnreadCounts, getThreadDetail, listThreads } from "../src/worker/services/mail";
import {
  instrumentHtmlWithSelfHostedTracking,
  signTrackingToken,
  TRANSPARENT_GIF_BYTES,
} from "../src/worker/services/tracking";
import { createMailTransport, resolveMailProvider } from "../src/worker/services/transports";
import {
  buildSnsCanonicalSigningString,
  SesEmailTransport,
  type SnsMessageEnvelope,
} from "../src/worker/services/transports/ses-transport";
import { buildTestEnv, resetDatabaseAndStorage } from "./helpers/test-env";

const textEncoder = new TextEncoder();

function createMockCtx() {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      tasks.push(Promise.resolve(promise));
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    flush: () => Promise.all(tasks),
  };
}

function buildRawMimeStream(rawMime: string): {
  stream: ReadableStream<Uint8Array>;
  size: number;
} {
  const bytes = textEncoder.encode(rawMime);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return { stream, size: bytes.byteLength };
}

function createMockForwardableEmail(options: {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  inReplyTo?: string;
  text?: string;
  html?: string;
  attachment?: { filename: string; contentType: string; data: Uint8Array };
}): ForwardableEmailMessage {
  const boundary = "----=_Part_Postlet_Test_001";
  const headersList: Array<[string, string]> = [
    ["From", options.from],
    ["To", options.to],
    ["Subject", options.subject],
    ["Message-ID", options.messageId],
    ["Date", "Sun, 22 Nov 2026 12:00:00 +0000"],
    ["MIME-Version", "1.0"],
  ];
  if (options.inReplyTo) {
    headersList.push(["In-Reply-To", options.inReplyTo]);
    headersList.push(["References", options.inReplyTo]);
  }

  const lines: string[] = [
    ...headersList.map(([k, v]) => `${k}: ${v}`),
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "",
    options.text ?? "Plain text body",
    "",
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    "",
    options.html ?? "<p>HTML body</p>",
    "",
  ];

  if (options.attachment) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${options.attachment.contentType}; name="${options.attachment.filename}"`,
      `Content-Disposition: attachment; filename="${options.attachment.filename}"`,
      `Content-Transfer-Encoding: base64`,
      "",
      bytesToBase64(options.attachment.data),
      "",
    );
  }
  lines.push(`--${boundary}--`, "");

  const rawMime = lines.join("\r\n");
  const { stream, size } = buildRawMimeStream(rawMime);
  const headers = new Headers(headersList);

  return {
    from: options.from.replace(/^.*<([^>]+)>$/, "$1").trim().toLowerCase(),
    to: options.to.trim().toLowerCase(),
    headers,
    raw: stream,
    rawSize: size,
    canBeForwarded: true,
    setReject() {},
    async forward() {
      return { messageId: "fwd_mock" };
    },
    async reply() {
      return { messageId: "reply_mock" };
    },
  };
}

function encodeDerLength(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  if (len <= 0xff) return new Uint8Array([0x81, len]);
  return new Uint8Array([0x82, (len >> 8) & 0xff, len & 0xff]);
}

function encodeDerTlv(tag: number, content: Uint8Array): Uint8Array {
  const lenBytes = encodeDerLength(content.byteLength);
  const out = new Uint8Array(1 + lenBytes.byteLength + content.byteLength);
  out[0] = tag;
  out.set(lenBytes, 1);
  out.set(content, 1 + lenBytes.byteLength);
  return out;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Generates a real RSA-2048 signing keypair and wraps its exported SPKI bytes inside a valid
 * minimal ASN.1 DER X.509 certificate + PEM so SNS signature verification runs end-to-end.
 */
async function createTestSnsSigner() {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const spkiBytes = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  const emptySeq = encodeDerTlv(0x30, new Uint8Array(0));
  const versionTlv = encodeDerTlv(0xa0, encodeDerTlv(0x02, new Uint8Array([0x02])));
  const serialTlv = encodeDerTlv(0x02, new Uint8Array([0x01]));
  const tbsCert = encodeDerTlv(
    0x30,
    concatBytes(versionTlv, serialTlv, emptySeq, emptySeq, emptySeq, emptySeq, spkiBytes),
  );
  const dummySigBitString = encodeDerTlv(0x03, new Uint8Array([0x00]));
  const certDer = encodeDerTlv(0x30, concatBytes(tbsCert, emptySeq, dummySigBitString));
  const pem = `-----BEGIN CERTIFICATE-----\n${bytesToBase64(certDer)}\n-----END CERTIFICATE-----\n`;

  async function signEnvelope(
    envelope: Omit<SnsMessageEnvelope, "Signature">,
  ): Promise<SnsMessageEnvelope> {
    const full = { ...envelope, Signature: "" };
    const canonical = buildSnsCanonicalSigningString(full);
    const sigBuf = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      textEncoder.encode(canonical),
    );
    return {
      ...envelope,
      Signature: bytesToBase64(new Uint8Array(sigBuf)),
    };
  }

  return { pem, signEnvelope };
}

describe("Modular Mail Transports, Free Cloudflare Inbound, Multi-Domain & Tracking", () => {
  beforeEach(async () => {
    await resetDatabaseAndStorage();
  });

  it("ingests free Cloudflare Email Routing streams via postal-mime, saves R2 attachments, threads replies, and enforces multi-domain catch-all", async () => {
    await updateSettings(env.DB, {
      mailDomains: ["phnxlabs.dev", "other.example"],
      catchAllEnabled: true,
    });
    const testEnv = buildTestEnv({ MAIL_DOMAIN: "phnxlabs.dev,other.example" });
    const attachmentBytes = textEncoder.encode("Quarter summary attachment body.");

    // 1. Primary domain inbound with multipart HTML + base64 attachment through worker.email()
    const msg1 = createMockForwardableEmail({
      from: "Alice Sender <alice@client.org>",
      to: "hello@phnxlabs.dev",
      subject: "Project Kickoff",
      messageId: "<kickoff-1@client.org>",
      text: "Hello PhnxLabs team!",
      html: "<p>Hello <strong>PhnxLabs</strong> team!</p>",
      attachment: {
        filename: "report.txt",
        contentType: "text/plain",
        data: attachmentBytes,
      },
    });
    const { ctx, flush } = createMockCtx();
    await worker.email(msg1, testEnv, ctx);
    await flush();

    // Verify D1 thread/message + R2 attachment binary
    const threadsAfter1 = await listThreads(env.DB, { folder: "inbox" });
    expect(threadsAfter1).toHaveLength(1);
    const detail1 = await getThreadDetail(env.DB, threadsAfter1[0].id);
    expect(detail1?.messages).toHaveLength(1);
    expect(detail1?.messages[0].resendEmailId).toMatch(/^cf_/);
    expect(detail1?.messages[0].attachments).toHaveLength(1);
    expect(detail1?.messages[0].attachments[0].filename).toBe("report.txt");

    const r2Obj = await env.ATTACHMENTS.get(detail1!.messages[0].attachments[0].r2Key);
    expect(r2Obj).not.toBeNull();
    expect(await r2Obj!.text()).toBe("Quarter summary attachment body.");

    // 2. Duplicate delivery is idempotent
    const dupMsg = createMockForwardableEmail({
      from: "Alice Sender <alice@client.org>",
      to: "hello@phnxlabs.dev",
      subject: "Project Kickoff",
      messageId: "<kickoff-1@client.org>",
    });
    const dupRes = await handleCloudflareInboundEmail(dupMsg, testEnv, ctx);
    expect(dupRes).toEqual({
      created: false,
      ignored: false,
      threadId: threadsAfter1[0].id,
      messageId: detail1!.messages[0].id,
    });

    // 3. Reply matching In-Reply-To threads cleanly into existing thread
    const replyMsg = createMockForwardableEmail({
      from: "Alice Sender <alice@client.org>",
      to: "hello@phnxlabs.dev",
      subject: "Re: Project Kickoff",
      messageId: "<kickoff-2@client.org>",
      inReplyTo: "<kickoff-1@client.org>",
      text: "Following up on our call.",
    });
    const replyRes = await handleCloudflareInboundEmail(replyMsg, testEnv, ctx);
    expect(replyRes.created).toBe(true);
    expect(replyRes.threadId).toBe(threadsAfter1[0].id);

    // 4. Second configured domain works; unconfigured domain is ignored
    const msgOther = createMockForwardableEmail({
      from: "Vendor <billing@saas.io>",
      to: "finance@other.example",
      subject: "Invoice 2026-11",
      messageId: "<inv-1@saas.io>",
    });
    const resOther = await handleCloudflareInboundEmail(msgOther, testEnv, ctx);
    expect(resOther.created).toBe(true);

    const msgStranger = createMockForwardableEmail({
      from: "Spammer <spam@bad.example>",
      to: "target@stranger.org",
      subject: "Unrelated domain",
      messageId: "<stranger-1@bad.example>",
    });
    const resStranger = await handleCloudflareInboundEmail(msgStranger, testEnv, ctx);
    expect(resStranger.created).toBe(false);
    expect(resStranger.ignored).toBe(true);
  });

  it("supports unified and domain-scoped inboxes, domain unread counts, and multi-domain loop protection", async () => {
    await updateSettings(env.DB, {
      mailDomains: ["phnxlabs.dev", "other.example"],
      catchAllEnabled: true,
    });
    const testEnv = buildTestEnv({
      MAIL_DOMAIN: "phnxlabs.dev,other.example",
      TRACKING_BASE_URL: "https://mail.example.com",
      TRACKING_SECRET: "tracking-secret-1",
    });
    const { ctx } = createMockCtx();

    await handleCloudflareInboundEmail(
      createMockForwardableEmail({
        from: "Human <client@partner.io>",
        to: "support@phnxlabs.dev",
        subject: "PhnxLabs inquiry",
        messageId: "<m-phnx-1@partner.io>",
      }),
      testEnv,
      ctx,
    );
    await handleCloudflareInboundEmail(
      createMockForwardableEmail({
        from: "Sales Lead <lead@buyer.com>",
        to: "sales@other.example",
        subject: "Other domain inquiry",
        messageId: "<m-other-1@buyer.com>",
      }),
      testEnv,
      ctx,
    );

    // Unified view vs per-domain filtered service queries & HTTP route
    const unified = await listThreads(env.DB, { folder: "inbox" });
    expect(unified).toHaveLength(2);

    const phnxOnly = await listThreads(env.DB, { folder: "inbox", domain: "phnxlabs.dev" });
    expect(phnxOnly).toHaveLength(1);
    expect(phnxOnly[0].recipientAddress).toBe("support@phnxlabs.dev");

    const app = createApp();
    const otherRes = await app.fetch(
      new Request("http://localhost/api/admin/threads?folder=inbox&domain=other.example"),
      testEnv,
    );
    expect(otherRes.status).toBe(200);
    const otherJson = (await otherRes.json()) as { threads: ThreadSummary[] };
    expect(otherJson.threads).toHaveLength(1);
    expect(otherJson.threads[0].recipientAddress).toBe("sales@other.example");

    // Per-domain unread counts + /api/admin/meta telemetry
    const domainCounts = await getDomainUnreadCounts(env.DB);
    expect(domainCounts).toEqual({
      "phnxlabs.dev": 1,
      "other.example": 1,
    });

    const metaRes = await app.fetch(new Request("http://localhost/api/admin/meta"), testEnv);
    expect(metaRes.status).toBe(200);
    const meta = (await metaRes.json()) as AdminMetaResponse;
    expect(meta.mailProvider).toBe("resend");
    expect(meta.selfHostedTrackingEnabled).toBe(true);
    expect(meta.domainUnreadCounts).toEqual({
      "phnxlabs.dev": 1,
      "other.example": 1,
    });

    // Multi-domain RFC 3834 loop protection blocks any owned domain but allows external senders
    const phnxDetail = await getThreadDetail(env.DB, phnxOnly[0].id);
    const externalMsg = phnxDetail!.messages[0];
    expect(await checkAutoReplySafety(env.DB, externalMsg, ["phnxlabs.dev", "other.example"])).toBeNull();

    const sameDomainMsg = { ...externalMsg, fromAddress: "bot@other.example" };
    expect(
      await checkAutoReplySafety(env.DB, sameDomainMsg, ["phnxlabs.dev", "other.example"]),
    ).toContain("local mail domain");
  });

  it("sends outbound email via Cloudflare EmailTransport and applies worker.queue() delivery events", async () => {
    await createAddress(env.DB, {
      email: "owner@mail.example.com",
      displayName: "Owner",
      isDefault: true,
    });

    const sendCalls: Array<Record<string, unknown>> = [];
    const mockEmailBinding = {
      send: vi.fn(async (msg) => {
        sendCalls.push(msg as unknown as Record<string, unknown>);
        return { messageId: `cf_msg_${sendCalls.length}` };
      }),
    };

    const testEnv = buildTestEnv({
      MAIL_PROVIDER: "cloudflare",
      EMAIL: mockEmailBinding,
    });
    expect(resolveMailProvider(testEnv)).toBe("cloudflare");
    expect(createMailTransport(testEnv).provider).toBe("cloudflare");

    const app = createApp();
    const sendMail = async (to: string, subject: string) => {
      const res = await app.fetch(
        new Request("http://localhost/api/admin/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Postlet-CSRF": "1" },
          body: JSON.stringify({
            mode: "send",
            to: [to],
            subject,
            textBody: "Cloudflare outbound test",
          }),
        }),
        testEnv,
      );
      expect(res.status).toBe(200);
      return (await res.json()) as {
        message: { id: string; resendEmailId: string; status: string };
        threadId: string;
      };
    };

    const s1 = await sendMail("dest1@example.org", "CF Queue Delivery");
    const s2 = await sendMail("dest2@example.org", "CF Queue Bounce");
    const s3 = await sendMail("dest3@example.org", "CF Queue Complaint");
    expect(s1.message.resendEmailId).toBe("cf_msg_1");
    expect(s1.message.status).toBe("sent");

    const ackSpies = [vi.fn(), vi.fn(), vi.fn()];
    const batch = {
      queue: "postlet-email-events",
      messages: [
        {
          id: "q1",
          timestamp: new Date(),
          attempts: 1,
          body: { type: "message.delivered", messageId: "cf_msg_1", timestamp: "2026-11-22T20:00:00.000Z" },
          ack: ackSpies[0],
          retry() {},
        },
        {
          id: "q2",
          timestamp: new Date(),
          attempts: 1,
          body: {
            type: "message.bounced",
            messageId: "cf_msg_2",
            errorDetail: "550 5.1.1 Mailbox unavailable",
            timestamp: "2026-11-22T20:01:00.000Z",
          },
          ack: ackSpies[1],
          retry() {},
        },
        {
          id: "q3",
          timestamp: new Date(),
          attempts: 1,
          body: { type: "message.complained", messageId: "cf_msg_3", timestamp: "2026-11-22T20:02:00.000Z" },
          ack: ackSpies[2],
          retry() {},
        },
      ],
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<unknown>;

    const { ctx } = createMockCtx();
    await worker.queue(batch, testEnv, ctx);
    for (const ack of ackSpies) {
      expect(ack).toHaveBeenCalledTimes(1);
    }

    expect((await getThreadDetail(env.DB, s1.threadId))?.messages[0].status).toBe("delivered");
    const bouncedDetail = await getThreadDetail(env.DB, s2.threadId);
    expect(bouncedDetail?.messages[0].status).toBe("bounced");
    expect(bouncedDetail?.messages[0].deliveryError).toContain("550 5.1.1");
    expect((await getThreadDetail(env.DB, s3.threadId))?.messages[0].status).toBe("complained");
  });

  it("signs AWS SigV4 SES requests with RFC 5322 MIME + attachments and verifies SNS X.509 RSA webhooks", async () => {
    await createAddress(env.DB, {
      email: "alerts@mail.example.com",
      displayName: "Postlet SES",
      isDefault: true,
    });

    // 1. Verify SesEmailTransport SigV4 headers & RFC 5322 raw MIME serialization
    const sesRequests: Array<{
      url: string;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const mockSesTransportFetch: typeof fetch = async (input, init) => {
      sesRequests.push({
        url: typeof input === "string" ? input : input.toString(),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ MessageId: "ses_out_1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const sesTransport = new SesEmailTransport(
      {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        region: "us-east-1",
        configurationSet: "postlet-events",
      },
      mockSesTransportFetch,
    );
    const sendRes = await sesTransport.sendEmail({
      from: "Postlet SES <alerts@mail.example.com>",
      to: ["user@example.org"],
      subject: "SES SigV4 Test",
      text: "Hello from SES",
      html: "<p>Hello from <b>SES</b></p>",
      headers: { "Message-ID": "<ses-1@mail.example.com>", "In-Reply-To": "<orig@example.org>" },
      attachments: [
        {
          filename: "hello.txt",
          content: bytesToBase64(textEncoder.encode("SES attachment bytes")),
          content_type: "text/plain",
        },
      ],
    });

    expect(sendRes).toEqual({ id: "ses_out_1", initialStatus: "sent" });
    expect(sesRequests).toHaveLength(1);
    const firstSesReq = sesRequests[0];
    expect(firstSesReq.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
    expect(firstSesReq.headers.get("Authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//,
    );
    expect(firstSesReq.headers.get("X-Amz-Date")).toMatch(/^\d{8}T\d{6}Z$/);
    expect(firstSesReq.headers.get("X-Amz-Content-Sha256")).toMatch(/^[a-f0-9]{64}$/);
    expect(firstSesReq.body.ConfigurationSetName).toBe("postlet-events");

    const rawMimeBase64 = (firstSesReq.body as { Content: { Raw: { Data: string } } }).Content.Raw
      .Data;
    const rawBin = atob(rawMimeBase64);
    const rawBytes = new Uint8Array(rawBin.length);
    for (let i = 0; i < rawBin.length; i += 1) rawBytes[i] = rawBin.charCodeAt(i);
    const parsedMime = await PostalMime.parse(rawBytes);
    expect(parsedMime.subject).toBe("SES SigV4 Test");
    expect(parsedMime.inReplyTo).toBe("<orig@example.org>");
    expect(parsedMime.attachments).toHaveLength(1);
    expect(parsedMime.attachments[0].filename).toBe("hello.txt");

    // 2. Verify /api/webhooks/ses SNS verification (RSA-2048 X.509 PEM + SubscriptionConfirmation + Notifications)
    const { pem, signEnvelope } = await createTestSnsSigner();
    const certUrl = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem";
    const subscribeUrl = "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok123";
    const expectedTopicArn = "arn:aws:sns:us-east-1:123456789012:postlet-ses-events";
    const fetchedUrls: string[] = [];

    const mockNetworkFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchedUrls.push(url);
      if (url === certUrl) {
        return new Response(pem, { status: 200 });
      }
      if (url === subscribeUrl) {
        return new Response("ok", { status: 200 });
      }
      if (url.includes("/v2/email/outbound-emails")) {
        return mockSesTransportFetch(input, init);
      }
      return new Response("Not Found", { status: 404 });
    };

    const sesEnv = buildTestEnv({
      MAIL_PROVIDER: "ses",
      AWS_SES_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SES_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      AWS_SES_REGION: "us-east-1",
      SES_WEBHOOK_SECRET: "sns-hook-secret",
      SES_SNS_TOPIC_ARN: expectedTopicArn,
    });
    const app = createApp({ resendFetchFn: mockNetworkFetch });

    // Send one email through app so DB tracks ses_out_1
    const uiSend = await app.fetch(
      new Request("http://localhost/api/admin/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Postlet-CSRF": "1" },
        body: JSON.stringify({
          mode: "send",
          to: ["recipient@example.org"],
          subject: "Track via SNS",
          textBody: "Hi",
        }),
      }),
      sesEnv,
    );
    expect(uiSend.status).toBe(200);
    const { threadId } = (await uiSend.json()) as { threadId: string };

    // Valid SubscriptionConfirmation
    const subEnvelope = await signEnvelope({
      Type: "SubscriptionConfirmation",
      MessageId: "sns-sub-1",
      TopicArn: expectedTopicArn,
      Message: "You have chosen to subscribe",
      SubscribeURL: subscribeUrl,
      Token: "tok123",
      Timestamp: "2026-11-22T21:00:00.000Z",
      SignatureVersion: "2",
      SigningCertURL: certUrl,
    });
    const subRes = await app.fetch(
      new Request("http://localhost/api/webhooks/ses?secret=sns-hook-secret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subEnvelope),
      }),
      sesEnv,
    );
    expect(subRes.status).toBe(200);
    expect(await subRes.json()).toEqual({ ok: true, subscribed: true });
    expect(fetchedUrls).toContain(subscribeUrl);

    // Valid Delivery -> Open -> Click notifications
    for (const eventBody of [
      {
        eventType: "Delivery",
        mail: { messageId: "ses_out_1", timestamp: "2026-11-22T21:01:00.000Z" },
        delivery: { timestamp: "2026-11-22T21:01:02.000Z" },
      },
      {
        eventType: "Open",
        mail: { messageId: "ses_out_1", timestamp: "2026-11-22T21:01:00.000Z" },
        open: { timestamp: "2026-11-22T21:02:00.000Z" },
      },
      {
        eventType: "Click",
        mail: { messageId: "ses_out_1", timestamp: "2026-11-22T21:01:00.000Z" },
        click: { link: "https://phnxlabs.dev", timestamp: "2026-11-22T21:03:00.000Z" },
      },
    ]) {
      const signed = await signEnvelope({
        Type: "Notification",
        MessageId: `sns-${eventBody.eventType}`,
        TopicArn: expectedTopicArn,
        Message: JSON.stringify(eventBody),
        Timestamp: "2026-11-22T21:03:00.000Z",
        SignatureVersion: "2",
        SigningCertURL: certUrl,
      });
      const res = await app.fetch(
        new Request("http://localhost/api/webhooks/ses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-postlet-webhook-secret": "sns-hook-secret",
          },
          body: JSON.stringify(signed),
        }),
        sesEnv,
      );
      expect(res.status).toBe(200);
    }

    const detail = await getThreadDetail(env.DB, threadId);
    expect(detail?.messages[0].status).toBe("delivered");
    expect(detail?.messages[0].deliveryEvents.map((e) => e.type)).toEqual([
      "email.sent",
      "email.delivered",
      "email.opened",
      "email.clicked",
    ]);

    // Security rejections: wrong secret -> 401, mismatched TopicArn -> 403, untrusted cert URL -> 401, tampered sig -> 401
    const validNotif = await signEnvelope({
      Type: "Notification",
      MessageId: "sns-sec-test",
      TopicArn: expectedTopicArn,
      Message: JSON.stringify({ eventType: "Delivery", mail: { messageId: "ses_out_1" } }),
      Timestamp: "2026-11-22T21:04:00.000Z",
      SignatureVersion: "2",
      SigningCertURL: certUrl,
    });

    const wrongSecretRes = await app.fetch(
      new Request("http://localhost/api/webhooks/ses?secret=wrong", {
        method: "POST",
        body: JSON.stringify(validNotif),
      }),
      sesEnv,
    );
    expect(wrongSecretRes.status).toBe(401);

    const wrongTopicRes = await app.fetch(
      new Request("http://localhost/api/webhooks/ses?secret=sns-hook-secret", {
        method: "POST",
        body: JSON.stringify({ ...validNotif, TopicArn: "arn:aws:sns:us-east-1:0000:evil" }),
      }),
      sesEnv,
    );
    expect(wrongTopicRes.status).toBe(403);

    const untrustedCertRes = await app.fetch(
      new Request("http://localhost/api/webhooks/ses?secret=sns-hook-secret", {
        method: "POST",
        body: JSON.stringify({
          ...validNotif,
          SigningCertURL: "https://evil.example/cert.pem",
        }),
      }),
      sesEnv,
    );
    expect(untrustedCertRes.status).toBe(401);
    expect(fetchedUrls).not.toContain("https://evil.example/cert.pem");

    const tamperedSigRes = await app.fetch(
      new Request("http://localhost/api/webhooks/ses?secret=sns-hook-secret", {
        method: "POST",
        body: JSON.stringify({ ...validNotif, Message: '{"tampered":true}' }),
      }),
      sesEnv,
    );
    expect(tamperedSigRes.status).toBe(401);
  });

  it("instruments outbound HTML with signed self-hosted tracking URLs, records opens/clicks on /t/*, and rejects forged tokens", async () => {
    await createAddress(env.DB, {
      email: "owner@mail.example.com",
      displayName: "Owner",
      isDefault: true,
    });

    // 1. Unit check link rewriting preserves mailto: and #anchor while rewriting http(s)
    const trackedHtml = await instrumentHtmlWithSelfHostedTracking(
      `<p><a href="https://example.org/docs?a=1&amp;b=2">Docs</a> <a href="mailto:hi@example.org">Email</a> <a href="#top">Top</a></p>`,
      "",
      {
        messageId: "msg_unit_1",
        baseUrl: "https://mail.example.com/",
        secret: "unit-secret",
      },
    );
    expect(trackedHtml).toContain('href="https://mail.example.com/t/c/');
    expect(trackedHtml).toContain('href="mailto:hi@example.org"');
    expect(trackedHtml).toContain('href="#top"');
    expect(trackedHtml).toContain('<img src="https://mail.example.com/t/o/');

    // 2. End-to-end send via Cloudflare provider + tracking endpoints
    let capturedHtml = "";
    const testEnv = buildTestEnv({
      MAIL_PROVIDER: "cloudflare",
      TRACKING_BASE_URL: "https://mail.example.com",
      TRACKING_SECRET: "e2e-tracking-secret",
      EMAIL: {
        async send(msg) {
          capturedHtml = msg.html ?? "";
          return { messageId: "cf_tracked_1", delivered: ["reader@example.org"] };
        },
      },
    });
    const app = createApp();

    const sendRes = await app.fetch(
      new Request("http://localhost/api/admin/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Postlet-CSRF": "1" },
        body: JSON.stringify({
          mode: "send",
          to: ["reader@example.org"],
          subject: "Self-Hosted Engagement Test",
          htmlBody: `<p>Visit <a href="https://example.org/docs?a=1&b=2">our docs</a>.</p>`,
          trackOpensAndClicks: true,
        }),
      }),
      testEnv,
    );
    expect(sendRes.status).toBe(200);
    const { threadId } = (await sendRes.json()) as { threadId: string };

    const openMatch = capturedHtml.match(/https:\/\/mail\.example\.com(\/t\/o\/[^"']+\.gif)/);
    const clickMatch = capturedHtml.match(/https:\/\/mail\.example\.com(\/t\/c\/[^"']+)/);
    expect(openMatch).not.toBeNull();
    expect(clickMatch).not.toBeNull();

    // Hit open pixel
    const openRes = await app.fetch(new Request(`http://localhost${openMatch![1]}`), testEnv);
    expect(openRes.status).toBe(200);
    expect(openRes.headers.get("Content-Type")).toBe("image/gif");
    const gifBuf = new Uint8Array(await openRes.arrayBuffer());
    expect(gifBuf).toEqual(TRANSPARENT_GIF_BYTES);

    // Hit click redirect
    const clickRes = await app.fetch(new Request(`http://localhost${clickMatch![1]}`), testEnv);
    expect(clickRes.status).toBe(302);
    expect(clickRes.headers.get("Location")).toBe("https://example.org/docs?a=1&b=2");

    // Engagement persisted without altering "delivered" status
    const detail = await getThreadDetail(env.DB, threadId);
    const msg = detail?.messages[0];
    expect(msg?.status).toBe("delivered");
    expect(msg?.deliveryEvents.map((e) => e.type)).toEqual([
      "email.delivered",
      "email.opened",
      "email.clicked",
    ]);
    expect(msg?.deliveryEvents[2].detail).toBe("https://example.org/docs?a=1&b=2");

    // Tampered token -> 403; unsafe redirect scheme even if validly signed -> 400
    const forgedRes = await app.fetch(
      new Request("http://localhost/t/c/tamperedPayload.invalidSig"),
      testEnv,
    );
    expect(forgedRes.status).toBe(403);

    const jsToken = await signTrackingToken(
      { t: "c", m: msg!.id, u: "javascript:alert(1)" },
      "e2e-tracking-secret",
    );
    const unsafeSchemeRes = await app.fetch(
      new Request(`http://localhost/t/c/${jsToken}`),
      testEnv,
    );
    expect(unsafeSchemeRes.status).toBe(400);
  });
});
