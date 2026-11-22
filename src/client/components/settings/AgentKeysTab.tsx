/**
 * @file src/client/components/settings/AgentKeysTab.tsx
 * @description Tactile Soft UI settings tab to mint and revoke scoped AI agent API keys
 * (`read_only`, `read_draft`, `read_write`) with alias locks, domain allowlists, built-in AI
 * function toggles, and one-click MCP / curl / OpenAPI onboarding snippets.
 */

import { Check, Copy, KeyRound, Plus, ShieldOff } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  AddressRecord,
  AgentKeyRecord,
  AgentOnboardingSnippets,
  AgentScope,
  BuiltInAiFunction,
} from "../../../shared/types";
import { api } from "../../lib/api";

interface AgentKeysTabProps {
  addresses: AddressRecord[];
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

const ALL_FUNCTIONS: Array<{ id: BuiltInAiFunction; label: string }> = [
  { id: "daily_summary", label: "Daily Inbox Summary" },
  { id: "important_auto_reply", label: "Important Auto-Reply" },
  { id: "triage", label: "Thread Summary & Triage" },
];

export function AgentKeysTab({ addresses, onSuccess, onError }: AgentKeysTabProps) {
  const [keys, setKeys] = useState<AgentKeyRecord[]>([]);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<AgentScope>("read_only");
  const [allowedAddressId, setAllowedAddressId] = useState<string>("");
  const [allowedDomainsRaw, setAllowedDomainsRaw] = useState("");
  const [rateLimit, setRateLimit] = useState(60);
  const [allowedFunctions, setAllowedFunctions] = useState<BuiltInAiFunction[]>([
    "daily_summary",
    "important_auto_reply",
    "triage",
  ]);
  const [creating, setCreating] = useState(false);

  const [revealed, setRevealed] = useState<{
    secret: string;
    snippets: AgentOnboardingSnippets;
  } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function loadKeys() {
    try {
      const res = await api.listAgentKeys();
      setKeys(res.keys);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load agent keys");
    }
  }

  useEffect(() => {
    void loadKeys();
  }, []);

  function toggleFn(fn: BuiltInAiFunction) {
    setAllowedFunctions((prev) =>
      prev.includes(fn) ? prev.filter((item) => item !== fn) : [...prev, fn],
    );
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const domains = allowedDomainsRaw
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);

      const res = await api.createAgentKey({
        name: name.trim(),
        scope,
        allowedAddressId: allowedAddressId || null,
        allowedRecipientDomains: domains.length > 0 ? domains : null,
        allowedFunctions,
        rateLimitPerHour: Number(rateLimit) || 60,
      });

      setRevealed({ secret: res.plaintextSecret, snippets: res.snippets });
      setName("");
      setAllowedDomainsRaw("");
      await loadKeys();
      onSuccess("Agent API key created. Copy the secret now — it will not be shown again.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to create agent key");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    try {
      await api.revokeAgentKey(id);
      await loadKeys();
      onSuccess("Agent key revoked.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to revoke key");
    }
  }

  function copyText(id: string, value: string) {
    void navigator.clipboard.writeText(value).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 2000);
    });
  }

  return (
    <div className="space-y-6">
      {/* Create Form */}
      <form onSubmit={(e) => void handleCreate(e)} className="neu-card rounded-2xl p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--neu-text)]">
          <KeyRound className="h-4 w-4 text-[var(--neu-coral-text)]" aria-hidden="true" />
          Create Scoped AI Agent API Key
        </h2>
        <p className="mt-1 text-xs text-[var(--neu-text-muted)]">
          Keys work seamlessly with both Postlet&apos;s native MCP endpoint (<code>/mcp</code>) and
          REST API (<code>/api/v1/*</code>). Keys are stored strictly as SHA-256 hashes.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="key-name"
              className="block text-xs font-medium text-[var(--neu-text-secondary)]"
            >
              Agent Name
            </label>
            <input
              id="key-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Claude Triage Agent"
              className="neu-input mt-1.5 w-full rounded-xl px-3.5 py-2 text-sm"
            />
          </div>

          <div>
            <label
              htmlFor="key-scope"
              className="block text-xs font-medium text-[var(--neu-text-secondary)]"
            >
              Permission Scope
            </label>
            <select
              id="key-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as AgentScope)}
              className="neu-input mt-1.5 w-full rounded-xl px-3.5 py-2 text-sm"
            >
              <option value="read_only">Read Only (read threads, search, read digests)</option>
              <option value="read_draft">Read &amp; Draft (queues drafts in Pending Approval)</option>
              <option value="read_write">Read &amp; Write (full immediate send via Resend)</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="key-alias"
              className="block text-xs font-medium text-[var(--neu-text-secondary)]"
            >
              Restrict to Configured Address (Optional)
            </label>
            <select
              id="key-alias"
              value={allowedAddressId}
              onChange={(e) => setAllowedAddressId(e.target.value)}
              className="neu-input mt-1.5 w-full rounded-xl px-3.5 py-2 text-sm"
            >
              <option value="">All mailbox addresses</option>
              {addresses.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="key-domains"
              className="block text-xs font-medium text-[var(--neu-text-secondary)]"
            >
              Allowed Recipient Domains (Optional, comma separated)
            </label>
            <input
              id="key-domains"
              type="text"
              value={allowedDomainsRaw}
              onChange={(e) => setAllowedDomainsRaw(e.target.value)}
              placeholder="e.g., acme.com, example.org"
              className="neu-input mt-1.5 w-full rounded-xl px-3.5 py-2 text-sm"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--neu-divider)] pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium text-[var(--neu-text-secondary)]">
              Built-In Functions:
            </span>
            {ALL_FUNCTIONS.map((fn) => (
              <label
                key={fn.id}
                className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 text-xs text-[var(--neu-text-secondary)] select-none"
              >
                <input
                  type="checkbox"
                  checked={allowedFunctions.includes(fn.id)}
                  onChange={() => toggleFn(fn.id)}
                  className="neu-checkbox"
                />
                {fn.label}
              </label>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-[var(--neu-text-secondary)]">
              Rate/hr:
              <input
                type="number"
                min={1}
                max={5000}
                value={rateLimit}
                onChange={(e) => setRateLimit(Number.parseInt(e.target.value, 10) || 60)}
                className="neu-input w-20 rounded-xl px-2.5 py-1.5 text-xs"
              />
            </label>
            <button
              type="submit"
              disabled={creating}
              className="neu-btn-accent inline-flex items-center gap-1.5 rounded-full px-5 py-2 text-xs font-semibold"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {creating ? "Generating..." : "Create Key"}
            </button>
          </div>
        </div>
      </form>

      {/* One-time Secret Reveal & Snippets */}
      {revealed && (
        <div className="neu-alert-success rounded-2xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              Key Created — Copy Secret Now (Shown Once)
            </h3>
            <button
              type="button"
              onClick={() => copyText("secret", revealed.secret)}
              className="neu-btn-success inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold"
            >
              {copiedId === "secret" ? (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {copiedId === "secret" ? "Copied Key" : "Copy Key"}
            </button>
          </div>
          <pre className="neu-code-block mt-2.5 overflow-x-auto rounded-xl p-3 font-mono text-xs text-emerald-300">
            {revealed.secret}
          </pre>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs font-medium">
                <span>MCP Client Config (/mcp)</span>
                <button
                  type="button"
                  onClick={() => copyText("mcp", revealed.snippets.mcpConfigJson)}
                  className="font-semibold hover:underline"
                >
                  {copiedId === "mcp" ? "Copied!" : "Copy JSON"}
                </button>
              </div>
              <pre className="neu-code-block overflow-x-auto rounded-xl p-3 font-mono text-[11px]">
                {revealed.snippets.mcpConfigJson}
              </pre>
            </div>

            <div className="space-y-3">
              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs font-medium">
                  <span>REST API cURL Example</span>
                  <button
                    type="button"
                    onClick={() => copyText("curl", revealed.snippets.curlCommand)}
                    className="font-semibold hover:underline"
                  >
                    {copiedId === "curl" ? "Copied!" : "Copy cURL"}
                  </button>
                </div>
                <pre className="neu-code-block overflow-x-auto rounded-xl p-3 font-mono text-[11px]">
                  {revealed.snippets.curlCommand}
                </pre>
              </div>
              <div className="text-xs">
                OpenAPI 3.1 Schema:{" "}
                <code className="neu-inset rounded px-2 py-0.5 text-[11px] text-[var(--neu-text)]">
                  {revealed.snippets.openApiUrl}
                </code>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Existing Keys */}
      <div className="neu-card rounded-2xl p-5">
        <h3 className="text-sm font-semibold text-[var(--neu-text)]">
          Issued Agent Keys ({keys.length})
        </h3>
        <div className="neu-inset mt-3 divide-y divide-[var(--neu-divider)] rounded-2xl">
          {keys.length === 0 ? (
            <p className="p-4 text-center text-xs text-[var(--neu-text-muted)]">
              No agent API keys created yet.
            </p>
          ) : (
            keys.map((k) => (
              <div
                key={k.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-[var(--neu-text)]">{k.name}</span>
                    <code className="neu-badge rounded-full px-2 py-0.5 text-[11px]">
                      {k.keyPrefix}…
                    </code>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${
                        k.scope === "read_only"
                          ? "neu-badge-info"
                          : k.scope === "read_draft"
                            ? "neu-badge-warning"
                            : "neu-badge-danger"
                      }`}
                    >
                      {k.scope}
                    </span>
                    {k.revokedAt && (
                      <span className="neu-badge rounded-full px-2 py-0.5 text-[10px] font-semibold">
                        Revoked
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-[var(--neu-text-muted)]">
                    Address: {k.allowedAddressEmail || "All"} · Rate: {k.rateLimitPerHour}/hr
                    {k.allowedRecipientDomains
                      ? ` · Domains: ${k.allowedRecipientDomains.join(", ")}`
                      : ""}
                    {k.lastUsedAt
                      ? ` · Last used: ${new Date(k.lastUsedAt).toLocaleString()}`
                      : " · Never used"}
                  </p>
                </div>

                {!k.revokedAt && (
                  <button
                    type="button"
                    onClick={() => void handleRevoke(k.id)}
                    className="neu-btn-danger inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium"
                  >
                    <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />
                    Revoke
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
