/**
 * @file src/client/components/settings/AddressesTab.tsx
 * @description Tactile Soft UI Settings panel displaying active transport/inbound status, managing
 * multiple configured catch-all domains, and configuring sender/alias addresses in Postlet.
 */

import { Globe, Plus, Server, Star, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AddressRecord, AppSettings, MailProviderId } from "../../../shared/types";
import { api } from "../../lib/api";

interface AddressesTabProps {
  settings: AppSettings;
  addresses: AddressRecord[];
  mailProvider: MailProviderId;
  selfHostedTrackingEnabled: boolean;
  onRefresh: () => Promise<void>;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

const PROVIDER_LABELS: Record<MailProviderId, string> = {
  resend: "Resend REST API",
  cloudflare: "Cloudflare Email Sending (send_email)",
  ses: "Amazon SES v2 (AWS SigV4)",
};

export function AddressesTab({
  settings,
  addresses,
  mailProvider,
  selfHostedTrackingEnabled,
  onRefresh,
  onSuccess,
  onError,
}: AddressesTabProps) {
  const initialDomains =
    settings.mailDomains.length > 0
      ? settings.mailDomains
      : settings.mailDomain
        ? [settings.mailDomain]
        : [];

  const [mailDomains, setMailDomains] = useState<string[]>(initialDomains);
  const [newDomainInput, setNewDomainInput] = useState("");
  const [catchAllEnabled, setCatchAllEnabled] = useState(settings.catchAllEnabled);
  const [savingDomain, setSavingDomain] = useState(false);

  const [newEmail, setNewEmail] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newIsDefault, setNewIsDefault] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const synced =
      settings.mailDomains.length > 0
        ? settings.mailDomains
        : settings.mailDomain
          ? [settings.mailDomain]
          : [];
    setMailDomains(synced);
    setCatchAllEnabled(settings.catchAllEnabled);
  }, [settings.mailDomains, settings.mailDomain, settings.catchAllEnabled]);

  function addDomainToList() {
    const cleaned = newDomainInput.trim().replace(/^@+/, "").toLowerCase();
    if (!cleaned) return;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(cleaned)) {
      onError("Enter a valid domain name (e.g., example.com).");
      return;
    }
    if (!mailDomains.includes(cleaned)) {
      setMailDomains((prev) => [...prev, cleaned]);
    }
    setNewDomainInput("");
  }

  function removeDomainFromList(domain: string) {
    setMailDomains((prev) => prev.filter((d) => d !== domain));
  }

  async function handleSaveDomain(e: React.FormEvent) {
    e.preventDefault();
    let finalDomains = mailDomains;
    const pending = newDomainInput.trim().replace(/^@+/, "").toLowerCase();
    if (pending) {
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(pending)) {
        onError("Enter a valid domain name (e.g., example.com).");
        return;
      }
      if (!finalDomains.includes(pending)) {
        finalDomains = [...finalDomains, pending];
        setMailDomains(finalDomains);
      }
      setNewDomainInput("");
    }

    setSavingDomain(true);
    try {
      await api.updateSettings({
        mailDomains: finalDomains,
        mailDomain: finalDomains[0] ?? "",
        catchAllEnabled,
      });
      await onRefresh();
      onSuccess("Domains and catch-all settings saved.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to update domain settings");
    } finally {
      setSavingDomain(false);
    }
  }

  async function handleCreateAddress(e: React.FormEvent) {
    e.preventDefault();
    if (!newEmail.trim()) return;
    setCreating(true);
    try {
      await api.createAddress({
        email: newEmail.trim().toLowerCase(),
        displayName: newDisplayName.trim(),
        isDefault: newIsDefault,
      });
      setNewEmail("");
      setNewDisplayName("");
      setNewIsDefault(false);
      await onRefresh();
      onSuccess("Address added.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to add address");
    } finally {
      setCreating(false);
    }
  }

  async function handleSetDefault(id: string) {
    try {
      await api.updateAddress(id, { isDefault: true });
      await onRefresh();
      onSuccess("Default sender address updated.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to update default address");
    }
  }

  async function handleToggleActive(addr: AddressRecord) {
    try {
      await api.updateAddress(addr.id, { isActive: !addr.isActive });
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to toggle address");
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteAddress(id);
      await onRefresh();
      onSuccess("Address removed.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to delete address");
    }
  }

  const primaryDomain = mailDomains[0] || "yourdomain.com";

  return (
    <div className="space-y-6">
      {/* Transport & Inbound Capabilities Banner */}
      <div className="neu-card rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="neu-inset flex h-9 w-9 items-center justify-center rounded-xl text-[var(--neu-coral-text)]">
              <Server className="h-4 w-4" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-[var(--neu-text)]">
                Mail Transport &amp; Routing Runtime
              </h2>
              <p className="mt-0.5 text-xs text-[var(--neu-text-muted)]">
                Configured via Worker environment variables (<code>MAIL_PROVIDER</code>) for clean
                per-instance isolation.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="neu-badge-coral rounded-full px-3 py-1 text-[11px] font-semibold">
              Outbound: {PROVIDER_LABELS[mailProvider]}
            </span>
            <span className="neu-badge-success rounded-full px-3 py-1 text-[11px] font-semibold">
              Inbound: Cloudflare Email Routing + Webhook
            </span>
            <span className="neu-badge rounded-full px-3 py-1 text-[11px] font-medium">
              Tracking: {selfHostedTrackingEnabled ? "Self-Hosted Worker (/t/*)" : "Provider Native"}
            </span>
          </div>
        </div>
      </div>

      {/* Multi-Domain & Catch-All */}
      <form onSubmit={(e) => void handleSaveDomain(e)} className="neu-card rounded-2xl p-5">
        <h2 className="text-base font-semibold text-[var(--neu-text)]">
          Domains &amp; Catch-All Routing
        </h2>
        <p className="mt-1 text-xs text-[var(--neu-text-muted)]">
          Point one or multiple domains to this Worker via Cloudflare Email Routing or Resend
          webhooks. Select individual domains in the sidebar for per-domain inboxes, or browse all in
          Unified view.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="mail-domain-add"
              className="block text-xs font-medium text-[var(--neu-text-secondary)]"
            >
              Add Owned Domain
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <input
                id="mail-domain-add"
                type="text"
                value={newDomainInput}
                onChange={(e) => setNewDomainInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addDomainToList();
                  }
                }}
                placeholder="yourdomain.com"
                className="neu-input w-full rounded-xl px-3.5 py-2 text-sm"
              />
              <button
                type="button"
                onClick={addDomainToList}
                className="neu-btn shrink-0 rounded-full px-3.5 py-2 text-xs font-semibold"
              >
                Add
              </button>
            </div>
          </div>

          <div className="flex items-end">
            <label className="neu-inset flex min-h-[44px] w-full cursor-pointer items-center justify-between gap-3 rounded-xl px-3.5 py-1.5 text-sm text-[var(--neu-text)] select-none">
              <span className="text-xs font-medium">
                Accept catch-all mail across configured domains
              </span>
              <input
                type="checkbox"
                role="switch"
                {...({ switch: "" } as Record<string, string>)}
                checked={catchAllEnabled}
                onChange={(e) => setCatchAllEnabled(e.target.checked)}
                className="neu-switch"
              />
            </label>
          </div>
        </div>

        {/* Configured Domain Chips */}
        {mailDomains.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {mailDomains.map((dom, idx) => (
              <span
                key={dom}
                className="neu-inset inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium text-[var(--neu-text)]"
              >
                <Globe className="h-3.5 w-3.5 text-[var(--neu-coral-text)]" aria-hidden="true" />
                <span>{dom}</span>
                {idx === 0 && (
                  <span className="neu-badge-coral rounded-full px-1.5 py-0.5 text-[10px] font-semibold">
                    primary
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeDomainFromList(dom)}
                  className="rounded-full p-0.5 text-[var(--neu-text-muted)] hover:text-[var(--neu-danger-text)]"
                  aria-label={`Remove domain ${dom}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button
            type="submit"
            disabled={savingDomain}
            className="neu-btn-accent rounded-full px-5 py-2 text-xs font-semibold"
          >
            {savingDomain ? "Saving..." : "Save Domain Config"}
          </button>
        </div>
      </form>

      {/* Add Address */}
      <form onSubmit={(e) => void handleCreateAddress(e)} className="neu-card rounded-2xl p-5">
        <h2 className="text-base font-semibold text-[var(--neu-text)]">
          Configured Addresses &amp; Aliases
        </h2>
        <p className="mt-1 text-xs text-[var(--neu-text-muted)]">
          Configure sender identities across your domains for composing, agent key alias scoping, and
          sidebar inbox filtering.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <input
            type="email"
            required
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder={`hello@${primaryDomain}`}
            className="neu-input rounded-xl px-3.5 py-2 text-sm"
          />
          <input
            type="text"
            value={newDisplayName}
            onChange={(e) => setNewDisplayName(e.target.value)}
            placeholder="Display Name (optional)"
            className="neu-input rounded-xl px-3.5 py-2 text-sm"
          />
          <div className="flex items-center justify-between gap-2">
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-xs font-medium text-[var(--neu-text-secondary)] select-none">
              <input
                type="checkbox"
                checked={newIsDefault}
                onChange={(e) => setNewIsDefault(e.target.checked)}
                className="neu-checkbox"
              />
              Default sender
            </label>
            <button
              type="submit"
              disabled={creating}
              className="neu-btn-accent inline-flex items-center gap-1 rounded-full px-4 py-2 text-xs font-semibold"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add
            </button>
          </div>
        </div>

        {/* Configured Addresses Table */}
        <div className="neu-inset mt-5 divide-y divide-[var(--neu-divider)] rounded-2xl">
          {addresses.length === 0 ? (
            <p className="p-4 text-center text-xs text-[var(--neu-text-muted)]">
              No addresses added yet. Add your primary sending address above.
            </p>
          ) : (
            addresses.map((addr) => (
              <div
                key={addr.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--neu-text)]">
                      {addr.email}
                    </span>
                    {addr.isDefault && (
                      <span className="neu-badge-coral inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-semibold">
                        <Star className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
                        Default
                      </span>
                    )}
                    {!addr.isActive && (
                      <span className="neu-badge rounded-full px-2 py-0.5 text-[10px] font-medium">
                        Inactive
                      </span>
                    )}
                  </div>
                  {addr.displayName && (
                    <p className="text-xs text-[var(--neu-text-muted)]">{addr.displayName}</p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {!addr.isDefault && addr.isActive && (
                    <button
                      type="button"
                      onClick={() => void handleSetDefault(addr.id)}
                      className="neu-btn rounded-full px-3 py-1 text-xs font-medium"
                    >
                      Make Default
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleToggleActive(addr)}
                    className="neu-btn rounded-full px-3 py-1 text-xs font-medium"
                  >
                    {addr.isActive ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(addr.id)}
                    className="neu-icon-btn h-8 w-8 text-[var(--neu-danger-text)]"
                    aria-label={`Delete ${addr.email}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </form>
    </div>
  );
}
