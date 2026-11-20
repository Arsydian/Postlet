/**
 * @file src/client/components/settings/AgentKeysTab.tsx
 * @description Settings tab to mint and revoke scoped AI agent API keys (`read_only`,
 * `read_draft`, `read_write`) with alias locks, domain allowlists, built-in AI function
 * toggles, and one-click MCP / curl / OpenAPI onboarding snippets.
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
      <form
        onSubmit={(e) => void handleCreate(e)}
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs"
      >
        <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
          <KeyRound className="h-4 w-4 text-indigo-600" />
          Create Scoped AI Agent API Key
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Keys work seamlessly with both Postlet&apos;s native MCP endpoint (<code>/mcp</code>) and
          REST API (<code>/api/v1/*</code>). Keys are stored strictly as SHA-256 hashes.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="key-name" className="block text-xs font-medium text-slate-700">
              Agent Name
            </label>
            <input
              id="key-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Claude Triage Agent"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="key-scope" className="block text-xs font-medium text-slate-700">
              Permission Scope
            </label>
            <select
              id="key-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as AgentScope)}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            >
              <option value="read_only">Read Only (read threads, search, read digests)</option>
              <option value="read_draft">Read &amp; Draft (queues drafts in Pending Approval)</option>
              <option value="read_write">Read &amp; Write (full immediate send via Resend)</option>
            </select>
          </div>

          <div>
            <label htmlFor="key-alias" className="block text-xs font-medium text-slate-700">
              Restrict to Configured Address (Optional)
            </label>
            <select
              id="key-alias"
              value={allowedAddressId}
              onChange={(e) => setAllowedAddressId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
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
            <label htmlFor="key-domains" className="block text-xs font-medium text-slate-700">
              Allowed Recipient Domains (Optional, comma separated)
            </label>
            <input
              id="key-domains"
              type="text"
              value={allowedDomainsRaw}
              onChange={(e) => setAllowedDomainsRaw(e.target.value)}
              placeholder="e.g., acme.com, example.org"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium text-slate-700">Built-In Functions:</span>
            {ALL_FUNCTIONS.map((fn) => (
              <label key={fn.id} className="inline-flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={allowedFunctions.includes(fn.id)}
                  onChange={() => toggleFn(fn.id)}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600"
                />
                {fn.label}
              </label>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              Rate/hr:
              <input
                type="number"
                min={1}
                max={5000}
                value={rateLimit}
                onChange={(e) => setRateLimit(Number.parseInt(e.target.value, 10) || 60)}
                className="w-20 rounded-lg border border-slate-200 px-2 py-1 text-xs"
              />
            </label>
            <button
              type="submit"
              disabled={creating}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              {creating ? "Generating..." : "Create Key"}
            </button>
          </div>
        </div>
      </form>

      {/* One-time Secret Reveal & Snippets */}
      {revealed && (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50/70 p-5 shadow-xs">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-emerald-950">
              Key Created — Copy Secret Now (Shown Once)
            </h3>
            <button
              type="button"
              onClick={() => copyText("secret", revealed.secret)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-800"
            >
              {copiedId === "secret" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copiedId === "secret" ? "Copied Key" : "Copy Key"}
            </button>
          </div>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-xs text-emerald-300">
            {revealed.secret}
          </pre>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs font-medium text-emerald-900">
                <span>MCP Client Config (/mcp)</span>
                <button
                  type="button"
                  onClick={() => copyText("mcp", revealed.snippets.mcpConfigJson)}
                  className="text-emerald-700 hover:underline"
                >
                  {copiedId === "mcp" ? "Copied!" : "Copy JSON"}
                </button>
              </div>
              <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] text-slate-100">
                {revealed.snippets.mcpConfigJson}
              </pre>
            </div>

            <div className="space-y-3">
              <div>
                <div className="mb-1 flex items-center justify-between text-xs font-medium text-emerald-900">
                  <span>REST API cURL Example</span>
                  <button
                    type="button"
                    onClick={() => copyText("curl", revealed.snippets.curlCommand)}
                    className="text-emerald-700 hover:underline"
                  >
                    {copiedId === "curl" ? "Copied!" : "Copy cURL"}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] text-slate-100">
                  {revealed.snippets.curlCommand}
                </pre>
              </div>
              <div className="text-xs text-emerald-900">
                OpenAPI 3.1 Schema:{" "}
                <code className="rounded bg-white px-1.5 py-0.5 text-[11px]">
                  {revealed.snippets.openApiUrl}
                </code>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Existing Keys */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <h3 className="text-sm font-semibold text-slate-900">Issued Agent Keys ({keys.length})</h3>
        <div className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200">
          {keys.length === 0 ? (
            <p className="p-4 text-center text-xs text-slate-500">
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
                    <span className="text-sm font-medium text-slate-900">{k.name}</span>
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                      {k.keyPrefix}…
                    </code>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        k.scope === "read_only"
                          ? "bg-sky-50 text-sky-700"
                          : k.scope === "read_draft"
                            ? "bg-amber-50 text-amber-800"
                            : "bg-rose-50 text-rose-700"
                      }`}
                    >
                      {k.scope}
                    </span>
                    {k.revokedAt && (
                      <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                        Revoked
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
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
                    className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
                  >
                    <ShieldOff className="h-3.5 w-3.5" />
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
