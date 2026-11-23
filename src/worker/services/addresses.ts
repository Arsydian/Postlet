/**
 * @file src/worker/services/addresses.ts
 * @description Manages configured sender/alias addresses and global operational/AI settings in D1.
 */

import type { AddressRecord, AppSettings, AutoReplyMode } from "../../shared/types";

interface AddressRow {
  id: string;
  email: string;
  display_name: string;
  is_default: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
}

function mapAddressRow(row: AddressRow): AddressRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isDefault: row.is_default === 1,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Lists all configured owner email addresses ordered with default first.
 *
 * @param db D1 database binding.
 * @returns Configured addresses.
 */
export async function listAddresses(db: D1Database): Promise<AddressRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT id, email, display_name, is_default, is_active, created_at, updated_at
       FROM addresses
       ORDER BY is_default DESC, email ASC`,
    )
    .all<AddressRow>();
  return (results ?? []).map(mapAddressRow);
}

/**
 * Finds an address by primary key ID.
 *
 * @param db D1 database binding.
 * @param id Address ID.
 * @returns Address record or null.
 */
export async function findAddressById(db: D1Database, id: string): Promise<AddressRecord | null> {
  const row = await db
    .prepare(
      `SELECT id, email, display_name, is_default, is_active, created_at, updated_at
       FROM addresses WHERE id = ?`,
    )
    .bind(id)
    .first<AddressRow>();
  return row ? mapAddressRow(row) : null;
}

/**
 * Finds a configured address by normalized email string.
 *
 * @param db D1 database binding.
 * @param email Email address (case-insensitive).
 * @returns Address record or null.
 */
export async function findAddressByEmail(
  db: D1Database,
  email: string,
): Promise<AddressRecord | null> {
  const row = await db
    .prepare(
      `SELECT id, email, display_name, is_default, is_active, created_at, updated_at
       FROM addresses WHERE lower(email) = ?`,
    )
    .bind(email.trim().toLowerCase())
    .first<AddressRow>();
  return row ? mapAddressRow(row) : null;
}

/**
 * Returns the active default sender address, or the first active configured address if no explicit
 * default flag is set.
 *
 * @param db D1 database binding.
 * @returns Default AddressRecord or null if none exist yet.
 */
export async function getDefaultAddress(db: D1Database): Promise<AddressRecord | null> {
  const row = await db
    .prepare(
      `SELECT id, email, display_name, is_default, is_active, created_at, updated_at
       FROM addresses
       WHERE is_active = 1
       ORDER BY is_default DESC, created_at ASC
       LIMIT 1`,
    )
    .first<AddressRow>();
  return row ? mapAddressRow(row) : null;
}

/**
 * Creates a new configured sender/alias address. If `isDefault` is true or this is the very first
 * address in the system, marks it as the single default address.
 *
 * @param db D1 database binding.
 * @param input Address creation fields.
 * @returns Newly created address record.
 */
export async function createAddress(
  db: D1Database,
  input: { email: string; displayName?: string; isDefault?: boolean },
): Promise<AddressRecord> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const existingCountRow = await db
    .prepare(`SELECT COUNT(*) as cnt FROM addresses`)
    .first<{ cnt: number }>();
  const shouldBeDefault = Boolean(input.isDefault) || (existingCountRow?.cnt ?? 0) === 0;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const statements: D1PreparedStatement[] = [];
  if (shouldBeDefault) {
    statements.push(db.prepare(`UPDATE addresses SET is_default = 0, updated_at = ?`).bind(now));
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO addresses (id, email, display_name, is_default, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(id, normalizedEmail, input.displayName?.trim() ?? "", shouldBeDefault ? 1 : 0, now, now),
  );
  await db.batch(statements);

  const created = await findAddressById(db, id);
  if (!created) {
    throw new Error("Failed to read back created address");
  }
  return created;
}

/**
 * Updates display name, default status, or active status for an address.
 *
 * @param db D1 database binding.
 * @param id Address ID.
 * @param patch Fields to update.
 * @returns Updated record or null if not found.
 */
export async function updateAddress(
  db: D1Database,
  id: string,
  patch: { displayName?: string; isDefault?: boolean; isActive?: boolean },
): Promise<AddressRecord | null> {
  const existing = await findAddressById(db, id);
  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (patch.isDefault === true) {
    statements.push(db.prepare(`UPDATE addresses SET is_default = 0, updated_at = ?`).bind(now));
  }

  statements.push(
    db
      .prepare(
        `UPDATE addresses
         SET display_name = ?, is_default = ?, is_active = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        patch.displayName !== undefined ? patch.displayName : existing.displayName,
        patch.isDefault !== undefined ? (patch.isDefault ? 1 : 0) : existing.isDefault ? 1 : 0,
        patch.isActive !== undefined ? (patch.isActive ? 1 : 0) : existing.isActive ? 1 : 0,
        now,
        id,
      ),
  );

  await db.batch(statements);
  return findAddressById(db, id);
}

/**
 * Deletes an address by ID. If the deleted address was the default, promotes the oldest active
 * remaining address to default.
 *
 * @param db D1 database binding.
 * @param id Address ID.
 * @returns True if deleted, false if not found.
 */
export async function deleteAddress(db: D1Database, id: string): Promise<boolean> {
  const existing = await findAddressById(db, id);
  if (!existing) {
    return false;
  }
  await db.prepare(`DELETE FROM addresses WHERE id = ?`).bind(id).run();

  if (existing.isDefault) {
    const next = await getDefaultAddress(db);
    if (next) {
      await db
        .prepare(`UPDATE addresses SET is_default = 1, updated_at = ? WHERE id = ?`)
        .bind(new Date().toISOString(), next.id)
        .run();
    }
  }
  return true;
}

/**
 * Parses a comma- or whitespace-separated domain string into a deduplicated, normalized array
 * of lowercase domain names (stripping any leading `@`).
 */
export function parseDomainList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[\s,;]+/)) {
    const cleaned = token.trim().replace(/^@+/, "").toLowerCase();
    if (!cleaned || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(cleaned) || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function normalizeDomainArray(domains: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of domains) {
    for (const d of parseDomainList(raw)) {
      if (!seen.has(d)) {
        seen.add(d);
        out.push(d);
      }
    }
  }
  return out;
}

/**
 * Loads all operational & Cloudflare AI settings from D1, applying safe defaults if any key is absent.
 * Note: `aiEnabled` defaults strictly to `false`.
 *
 * @param db D1 database binding.
 * @param envMailDomain Optional fallback domain(s) from environment `MAIL_DOMAIN`.
 * @param defaultAiModel Optional fallback model from `DEFAULT_AI_MODEL`.
 * @returns Parsed AppSettings object.
 */
export async function getSettings(
  db: D1Database,
  envMailDomain = "",
  defaultAiModel = "@cf/meta/llama-3.2-3b-instruct",
): Promise<AppSettings> {
  const { results } = await db
    .prepare(`SELECT key, value, updated_at FROM app_settings`)
    .all<SettingRow>();
  const map = new Map<string, string>();
  for (const row of results ?? []) {
    map.set(row.key, row.value);
  }

  const bool = (key: string, fallback: boolean): boolean => {
    const raw = map.get(key);
    if (raw === undefined) return fallback;
    return raw === "true" || raw === "1";
  };

  const num = (key: string, fallback: number): number => {
    const raw = map.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const todayUtc = new Date().toISOString().slice(0, 10);
  const storedDate = map.get("ai_daily_date") ?? "";
  // Expose 0 if the stored count belongs to a previous UTC day so the UI displays current usage.
  const effectiveDailyCount = storedDate === todayUtc ? num("ai_daily_count", 0) : 0;

  const storedMode = map.get("ai_important_auto_reply_mode");
  const mode: AutoReplyMode = storedMode === "auto_send" ? "auto_send" : "approval";

  let mailDomains: string[] = [];
  const rawJsonDomains = map.get("mail_domains");
  if (rawJsonDomains !== undefined) {
    try {
      const parsed = JSON.parse(rawJsonDomains) as unknown;
      if (Array.isArray(parsed)) {
        mailDomains = normalizeDomainArray(parsed.filter((d): d is string => typeof d === "string"));
      }
    } catch {
      mailDomains = [];
    }
  } else {
    const fallbackRaw = map.get("mail_domain") ?? envMailDomain ?? "";
    mailDomains = parseDomainList(fallbackRaw);
  }

  const primaryDomain = mailDomains[0] ?? (map.get("mail_domain") || envMailDomain || "").trim().toLowerCase();
  if (mailDomains.length === 0 && primaryDomain) {
    mailDomains = parseDomainList(primaryDomain);
  }

  return {
    mailDomain: mailDomains[0] ?? primaryDomain,
    mailDomains,
    catchAllEnabled: bool("catch_all_enabled", true),
    aiEnabled: bool("ai_enabled", false),
    aiModel: map.get("ai_model") || defaultAiModel,
    aiDailyCap: num("ai_daily_cap", 50),
    aiDailyCount: effectiveDailyCount,
    aiDailyDate: storedDate || todayUtc,
    aiAutoTriageEnabled: bool("ai_auto_triage_enabled", false),
    aiDailySummaryEnabled: bool("ai_daily_summary_enabled", false),
    aiDailySummaryHour: Math.min(23, Math.max(0, num("ai_daily_summary_hour", 8))),
    aiDailySummaryTimezone: map.get("ai_daily_summary_timezone") || "UTC",
    aiDailySummaryEmailCopy: bool("ai_daily_summary_email_copy", false),
    aiDailySummaryLastRunDate: map.get("ai_daily_summary_last_run_date") ?? "",
    aiImportantAutoReplyEnabled: bool("ai_important_auto_reply_enabled", false),
    aiImportantAutoReplyMode: mode,
    aiImportantAutoReplyInstructions:
      map.get("ai_important_auto_reply_instructions") ||
      "Acknowledge receipt politely, confirm their message was received, and let them know I will follow up personally soon.",
    aiImportantAutoReplyCooldownHours: Math.max(
      1,
      num("ai_important_auto_reply_cooldown_hours", 24),
    ),
  };
}

/**
 * Persists one or more updated settings to D1 `app_settings`.
 *
 * @param db D1 database binding.
 * @param patch Partial settings fields to update.
 * @param envMailDomain Optional env fallback domain.
 * @returns Updated AppSettings snapshot.
 */
export async function updateSettings(
  db: D1Database,
  patch: Partial<AppSettings>,
  envMailDomain = "",
): Promise<AppSettings> {
  const entries: Array<[string, string]> = [];
  if (patch.mailDomains !== undefined) {
    const normalized = normalizeDomainArray(patch.mailDomains);
    entries.push(["mail_domains", JSON.stringify(normalized)]);
    entries.push(["mail_domain", normalized[0] ?? ""]);
  } else if (patch.mailDomain !== undefined) {
    const normalized = parseDomainList(patch.mailDomain);
    entries.push(["mail_domains", JSON.stringify(normalized)]);
    entries.push(["mail_domain", normalized[0] ?? patch.mailDomain.trim().toLowerCase()]);
  }
  if (patch.catchAllEnabled !== undefined)
    entries.push(["catch_all_enabled", String(patch.catchAllEnabled)]);
  if (patch.aiEnabled !== undefined) entries.push(["ai_enabled", String(patch.aiEnabled)]);
  if (patch.aiModel !== undefined) entries.push(["ai_model", patch.aiModel]);
  if (patch.aiDailyCap !== undefined) entries.push(["ai_daily_cap", String(patch.aiDailyCap)]);
  if (patch.aiAutoTriageEnabled !== undefined)
    entries.push(["ai_auto_triage_enabled", String(patch.aiAutoTriageEnabled)]);
  if (patch.aiDailySummaryEnabled !== undefined)
    entries.push(["ai_daily_summary_enabled", String(patch.aiDailySummaryEnabled)]);
  if (patch.aiDailySummaryHour !== undefined)
    entries.push(["ai_daily_summary_hour", String(patch.aiDailySummaryHour)]);
  if (patch.aiDailySummaryTimezone !== undefined)
    entries.push(["ai_daily_summary_timezone", patch.aiDailySummaryTimezone]);
  if (patch.aiDailySummaryEmailCopy !== undefined)
    entries.push(["ai_daily_summary_email_copy", String(patch.aiDailySummaryEmailCopy)]);
  if (patch.aiImportantAutoReplyEnabled !== undefined)
    entries.push(["ai_important_auto_reply_enabled", String(patch.aiImportantAutoReplyEnabled)]);
  if (patch.aiImportantAutoReplyMode !== undefined)
    entries.push(["ai_important_auto_reply_mode", patch.aiImportantAutoReplyMode]);
  if (patch.aiImportantAutoReplyInstructions !== undefined)
    entries.push(["ai_important_auto_reply_instructions", patch.aiImportantAutoReplyInstructions]);
  if (patch.aiImportantAutoReplyCooldownHours !== undefined)
    entries.push([
      "ai_important_auto_reply_cooldown_hours",
      String(patch.aiImportantAutoReplyCooldownHours),
    ]);

  if (entries.length > 0) {
    const now = new Date().toISOString();
    const stmt = db.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    await db.batch(entries.map(([key, value]) => stmt.bind(key, value, now)));
  }

  return getSettings(db, envMailDomain);
}

/**
 * Sets a single raw key in `app_settings` (used for counters and last-run watermarks).
 *
 * @param db D1 database binding.
 * @param key Setting key.
 * @param value String value.
 */
export async function setRawSetting(db: D1Database, key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, now)
    .run();
}
