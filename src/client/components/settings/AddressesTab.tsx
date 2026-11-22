/**
 * @file src/client/components/settings/AddressesTab.tsx
 * @description Tactile Soft UI Settings panel for managing domain catch-all receiving and
 * configured sender/alias addresses in Postlet.
 */

import { Plus, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import type { AddressRecord, AppSettings } from "../../../shared/types";
import { api } from "../../lib/api";

interface AddressesTabProps {
  settings: AppSettings;
  addresses: AddressRecord[];
  onRefresh: () => Promise<void>;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

export function AddressesTab({
  settings,
  addresses,
  onRefresh,
  onSuccess,
  onError,
}: AddressesTabProps) {
  const [mailDomain, setMailDomain] = useState(settings.mailDomain);
  const [catchAllEnabled, setCatchAllEnabled] = useState(settings.catchAllEnabled);
  const [savingDomain, setSavingDomain] = useState(false);

  const [newEmail, setNewEmail] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newIsDefault, setNewIsDefault] = useState(false);
  const [creating, setCreating] = useState(false);

  async function handleSaveDomain(e: React.FormEvent) {
    e.preventDefault();
    setSavingDomain(true);
    try {
      await api.updateSettings({
        mailDomain: mailDomain.trim().toLowerCase(),
        catchAllEnabled,
      });
      await onRefresh();
      onSuccess("Domain and catch-all settings saved.");
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

  return (
    <div className="space-y-6">
      {/* Domain & Catch-All */}
      <form onSubmit={(e) => void handleSaveDomain(e)} className="neu-card rounded-2xl p-5">
        <h2 className="text-base font-semibold text-[var(--neu-text)]">
          Domain &amp; Catch-All Routing
        </h2>
        <p className="mt-1 text-xs text-[var(--neu-text-muted)]">
          When Catch-All is enabled, incoming Resend webhooks to any address on your domain land in
          Postlet and can be filtered in the sidebar.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="mail-domain"
              className="block text-xs font-medium text-[var(--neu-text-secondary)]"
            >
              Primary Mail Domain
            </label>
            <input
              id="mail-domain"
              type="text"
              value={mailDomain}
              onChange={(e) => setMailDomain(e.target.value)}
              placeholder="mail.yourdomain.com"
              className="neu-input mt-1.5 w-full rounded-xl px-3.5 py-2 text-sm"
            />
          </div>

          <div className="flex items-end">
            <label className="neu-inset flex min-h-[44px] w-full cursor-pointer items-center justify-between gap-3 rounded-xl px-3.5 py-1.5 text-sm text-[var(--neu-text)] select-none">
              <span className="text-xs font-medium">
                Accept catch-all mail (*@{mailDomain || "yourdomain.com"})
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
          Configure sender identities for composing, agent key alias scoping, and sidebar inbox
          filtering.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <input
            type="email"
            required
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder={`hello@${mailDomain || "yourdomain.com"}`}
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
