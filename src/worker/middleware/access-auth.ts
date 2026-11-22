/**
 * @file src/worker/middleware/access-auth.ts
 * @description Cloudflare Zero Trust Access JWT middleware.
 * Cryptographically verifies RS256 Access JWTs against the team's public JWKS endpoint
 * using Web Crypto APIs, while allowing a tightly gated localhost-only bypass during
 * local development when `CF_ACCESS_AUD` is not configured.
 */

import type { MiddlewareHandler } from "hono";
import type { PostletEnv, PostletVariables } from "../env";
import { base64ToBytes, decodeBase64UrlText } from "../lib/crypto";

interface AccessJwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface AccessJwtPayload {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  email?: string;
  sub?: string;
}

interface JwkKey extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

interface JwksResponse {
  keys?: JwkKey[];
}

export interface VerifyAccessJwtOptions {
  teamDomain: string;
  audience: string;
  nowSeconds?: number;
  fetchFn?: typeof fetch;
}

/**
 * Extracts the Cloudflare Access JWT from either the `Cf-Access-Jwt-Assertion` header
 * or the `CF_Authorization` cookie.
 *
 * @param request Incoming HTTP request.
 * @returns Raw JWT string or null if absent.
 */
export function extractAccessJwt(request: Request): string | null {
  const headerToken = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (headerToken) {
    return headerToken;
  }

  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex <= 0) continue;
    const name = part.slice(0, eqIndex).trim();
    if (name === "CF_Authorization") {
      const value = part.slice(eqIndex + 1).trim();
      return value ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

/**
 * Normalizes a Cloudflare Access team domain (accepts `myteam.cloudflareaccess.com` or full URL).
 *
 * @param teamDomain Raw team domain configuration value.
 * @returns Canonical HTTPS issuer URL without trailing slash.
 */
function normalizeIssuer(teamDomain: string): string {
  const stripped = teamDomain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return `https://${stripped}`;
}

/**
 * Cryptographically verifies a Cloudflare Zero Trust Access JWT against the team's JWKS keys.
 *
 * @param token Raw JWT string.
 * @param options Team domain, audience tag, clock time, and optional fetch function.
 * @returns Verified JWT payload containing the owner's identity claims.
 * @throws Error when signature, issuer, audience, or timestamps fail verification.
 */
export async function verifyCloudflareAccessJwt(
  token: string,
  options: VerifyAccessJwtOptions,
): Promise<AccessJwtPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT structure");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = JSON.parse(decodeBase64UrlText(encodedHeader)) as AccessJwtHeader;
  const payload = JSON.parse(decodeBase64UrlText(encodedPayload)) as AccessJwtPayload;

  if (header.alg !== "RS256" || !header.kid) {
    throw new Error("Unsupported JWT algorithm or missing key ID");
  }

  const expectedIssuer = normalizeIssuer(options.teamDomain);
  if (payload.iss !== expectedIssuer) {
    throw new Error("JWT issuer mismatch");
  }

  const audiences = Array.isArray(payload.aud)
    ? payload.aud
    : payload.aud
      ? [payload.aud]
      : [];
  if (!audiences.includes(options.audience)) {
    throw new Error("JWT audience mismatch");
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || now >= payload.exp) {
    throw new Error("JWT is expired");
  }
  if (typeof payload.nbf === "number" && now < payload.nbf) {
    throw new Error("JWT is not yet active");
  }

  const certsUrl = `${expectedIssuer}/cdn-cgi/access/certs`;
  const customFetch =
    options.fetchFn && options.fetchFn !== globalThis.fetch ? options.fetchFn : null;
  const certsResponse = customFetch
    ? await customFetch(certsUrl, {
        headers: { Accept: "application/json" },
      })
    : await globalThis.fetch(certsUrl, {
        headers: { Accept: "application/json" },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
  if (!certsResponse.ok) {
    throw new Error(`Failed to fetch Cloudflare Access JWKS (${certsResponse.status})`);
  }

  const jwks = (await certsResponse.json()) as JwksResponse;
  const matchingKey = (jwks.keys ?? []).find((k) => k.kid === header.kid);
  if (!matchingKey) {
    throw new Error("Matching signing key not found in JWKS");
  }

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    matchingKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signatureBytes = base64ToBytes(encodedSignature);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    signatureBytes,
    signingInput,
  );

  if (!valid) {
    throw new Error("Invalid JWT signature");
  }

  return payload;
}

/**
 * Checks whether local-development Access bypass is safely permitted for this request.
 * Only succeeds when ALL three conditions hold:
 * 1. `DEV_BYPASS_ACCESS` is explicitly `"true"`
 * 2. `CF_ACCESS_AUD` is NOT configured (prevents accidental bypass in production)
 * 3. Request hostname is `localhost` or `127.0.0.1`
 */
function isLocalDevBypassAllowed(request: Request, env: PostletEnv): boolean {
  if (env.DEV_BYPASS_ACCESS !== "true") {
    return false;
  }
  if (env.CF_ACCESS_AUD && env.CF_ACCESS_AUD.trim().length > 0) {
    return false;
  }
  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * Hono middleware enforcing Cloudflare Zero Trust Access authentication on owner routes.
 *
 * @param fetchFn Optional custom fetch implementation (primarily for tests).
 * @returns Hono middleware handler.
 */
export function createAccessAuthMiddleware(
  fetchFn?: typeof fetch,
): MiddlewareHandler<{ Bindings: PostletEnv; Variables: PostletVariables }> {
  return async (c, next) => {
    if (isLocalDevBypassAllowed(c.req.raw, c.env)) {
      c.set("ownerEmail", "owner@localhost");
      await next();
      return;
    }

    const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN?.trim();
    const audience = c.env.CF_ACCESS_AUD?.trim();
    if (!teamDomain || !audience) {
      return c.json(
        {
          error:
            "Cloudflare Zero Trust Access is not configured (missing CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD)",
        },
        401,
      );
    }

    const token = extractAccessJwt(c.req.raw);
    if (!token) {
      return c.json({ error: "Missing Cloudflare Zero Trust Access token" }, 401);
    }

    try {
      const payload = await verifyCloudflareAccessJwt(token, {
        teamDomain,
        audience,
        fetchFn,
      });
      const email = payload.email || payload.sub || "owner";
      c.set("ownerEmail", email);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "JWT verification failed";
      console.error(
        JSON.stringify({
          message: "access auth rejected",
          reason,
          path: new URL(c.req.url).pathname,
        }),
      );
      return c.json({ error: "Unauthorized" }, 401);
    }

    await next();
  };
}

const SAFE_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Enforces CSRF protection on all mutating `/api/admin/*` routes (`POST`, `PATCH`, `PUT`, `DELETE`)
 * because Zero Trust browser sessions authenticate via the `CF_Authorization` cookie.
 * Requires same-origin `Sec-Fetch-Site` / `Origin` and the custom `X-Postlet-CSRF: 1` header.
 */
export function createAdminCsrfMiddleware(): MiddlewareHandler<{
  Bindings: PostletEnv;
  Variables: PostletVariables;
}> {
  return async (c, next) => {
    if (SAFE_READ_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }

    const secFetchSite = c.req.header("Sec-Fetch-Site")?.trim().toLowerCase();
    if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
      return c.json({ error: "Forbidden: cross-site request blocked" }, 403);
    }

    const expectedOrigin = new URL(c.req.url).origin;
    const originHeader = c.req.header("Origin")?.trim();
    if (originHeader && originHeader !== expectedOrigin) {
      return c.json({ error: "Forbidden: origin mismatch" }, 403);
    }

    if (c.req.header("X-Postlet-CSRF") !== "1") {
      return c.json({ error: "Forbidden: missing CSRF header" }, 403);
    }

    await next();
  };
}
