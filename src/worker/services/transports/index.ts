/**
 * @file src/worker/services/transports/index.ts
 * @description Factory resolving the configured outbound `MailTransport` (`resend`, `cloudflare`,
 * or `ses`) from Worker environment bindings and secrets.
 */

import type { MailProviderId } from "../../../shared/types";
import type { PostletEnv } from "../../env";
import { ResendClient } from "../resend";
import { CloudflareEmailTransport } from "./cloudflare-transport";
import { SesEmailTransport } from "./ses-transport";
import type { MailTransport } from "./types";

export type { CloudflareEmailQueueEvent, MailTransport, OutboundAttachment, OutboundEmailPayload, OutboundSendResult } from "./types";
export { CloudflareEmailTransport, mapCloudflareQueueEventToDeliveryEvent } from "./cloudflare-transport";
export { SesEmailTransport } from "./ses-transport";

/**
 * Resolves the active outbound transport ID (`resend` by default when unset or unrecognized).
 */
export function resolveMailProvider(env: PostletEnv): MailProviderId {
  const raw = (env.MAIL_PROVIDER || "resend").trim().toLowerCase();
  if (raw === "cloudflare" || raw === "ses") {
    return raw;
  }
  return "resend";
}

/**
 * Instantiates the configured outbound `MailTransport` for the current Worker request/task.
 */
export function createMailTransport(env: PostletEnv, fetchFn?: typeof fetch): MailTransport {
  const provider = resolveMailProvider(env);
  if (provider === "cloudflare") {
    return new CloudflareEmailTransport(env.EMAIL);
  }
  if (provider === "ses") {
    return new SesEmailTransport(
      {
        accessKeyId: env.AWS_SES_ACCESS_KEY_ID ?? "",
        secretAccessKey: env.AWS_SES_SECRET_ACCESS_KEY ?? "",
        region: env.AWS_SES_REGION || "us-east-1",
        configurationSet: env.AWS_SES_CONFIGURATION_SET,
      },
      fetchFn,
    );
  }
  return new ResendClient(env.RESEND_API_KEY ?? "", fetchFn);
}
