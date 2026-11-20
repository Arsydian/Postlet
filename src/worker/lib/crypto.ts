/**
 * @file src/worker/lib/crypto.ts
 * @description Web Crypto utilities for constant-time secret verification, SHA-256 hashing,
 * secure token generation, and Base64 / Base64URL encoding in Cloudflare Workers.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Computes a lowercase hex SHA-256 digest of a UTF-8 string.
 * Used for hashing agent API keys at rest so raw keys are never stored in D1.
 *
 * @param input Plaintext string to hash.
 * @returns 64-character lowercase hex string.
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface CloudflareSubtleCrypto extends SubtleCrypto {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
}

/**
 * Compares two strings in constant time by hashing both inputs to fixed-size SHA-256 digests
 * first and comparing via Cloudflare Web Crypto `crypto.subtle.timingSafeEqual`.
 *
 * Hashing before comparing eliminates any length-based timing side channel.
 *
 * @param a First string to compare.
 * @param b Second string to compare.
 * @returns True if both strings are identical.
 */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", textEncoder.encode(a)),
    crypto.subtle.digest("SHA-256", textEncoder.encode(b)),
  ]);
  return (crypto.subtle as CloudflareSubtleCrypto).timingSafeEqual(hashA, hashB);
}

/**
 * Generates a cryptographically secure random bearer token with a human-readable prefix.
 *
 * @param prefix Token prefix (e.g., "plt_").
 * @param byteLength Number of random bytes (default 24 -> 48 hex chars).
 * @returns Prefixed random hex string.
 */
export function generateSecureToken(prefix: string, byteLength = 24): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}${hex}`;
}

/**
 * Encodes a byte buffer as standard Base64 without blowing the call stack on large payloads.
 *
 * @param bytes Binary payload to encode.
 * @returns Base64-encoded string.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Decodes a Base64 or Base64URL string into a `Uint8Array`.
 *
 * @param input Base64 or Base64URL string (with or without padding).
 * @returns Decoded bytes.
 */
export function base64ToBytes(input: string): Uint8Array<ArrayBuffer> {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const paddingNeeded = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(paddingNeeded);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decodes a Base64URL-encoded JWT segment into UTF-8 text.
 *
 * @param segment Base64URL string.
 * @returns Decoded UTF-8 string.
 */
export function decodeBase64UrlText(segment: string): string {
  return textDecoder.decode(base64ToBytes(segment));
}

/**
 * Encodes a UTF-8 string or byte array into Base64URL without padding.
 *
 * @param input UTF-8 string or byte array.
 * @returns Unpadded Base64URL string.
 */
export function encodeBase64Url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? textEncoder.encode(input) : input;
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
