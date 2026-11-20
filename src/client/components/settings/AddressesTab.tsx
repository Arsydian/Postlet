/**
 * @file src/client/components/settings/AddressesTab.tsx
 * @description Settings panel for managing domain catch-all receiving and configured sender/alias
 * addresses in Postlet.
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
      <form
        onSubmit={(e) => void handleSaveDomain(e)}
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs"
      >
        <h2 className="text-base font-semibold text-slate-900">Domain &amp; Catch-All Routing</h2>
        <p className="mt-1 text-xs text-slate-500">
          When Catch-All is enabled, incoming Resend webhooks to any address on your domain land in
          Postlet and can be filtered in the sidebar.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="mail-domain" className="block text-xs font-medium text-slate-700">
              Primary Mail Domain
            </label>
            <input
              id="mail-domain"
              type="text"
              value={mailDomain}
              onChange={(e) => setMailDomain(e.target.value)}
              placeholder="mail.yourdomain.com"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div className="flex items-end">
            <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2 text-sm text-slate-800 w-full">
              <input
                type="checkbox"
                checked={catchAllEnabled}
                onChange={(e) => setCatchAllEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span>Accept catch-all mail (*@{mailDomain || "yourdomain.com"})</span>
            </label>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="submit"
            disabled={savingDomain}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {savingDomain ? "Saving..." : "Save Domain Config"}
          </button>
        </div>
      </form>

      {/* Add Address */}
      <form
        onSubmit={(e) => void handleCreateAddress(e)}
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs"
      >
        <h2 className="text-base font-semibold text-slate-900">Configured Addresses &amp; Aliases</h2>
        <p className="mt-1 text-xs text-slate-500">
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
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
          <input
            type="text"
            value={newDisplayName}
            onChange={(e) => setNewDisplayName(e.target.value)}
            placeholder="Display Name (optional)"
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={newIsDefault}
                onChange={(e) => setNewIsDefault(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600"
              />
              Default sender
            </label>
            <button
              type="submit"
              disabled={creating}
              className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>
        </div>

        {/* Configured Addresses Table */}
        <div className="mt-5 divide-y divide-slate-100 rounded-xl border border-slate-200">
          {addresses.length === 0 ? (
            <p className="p-4 text-center text-xs text-slate-500">
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
                    <span className="text-sm font-medium text-slate-900">{addr.email}</span>
                    {addr.isDefault && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">
                        <Star className="h-2.5 w-2.5 fill-indigo-600" />
                        Default
                      </span>
                    )}
                    {!addr.isActive && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                        Inactive
                      </span>
                    )}
                  </div>
                  {addr.displayName && (
                    <p className="text-xs text-slate-500">{addr.displayName}</p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {!addr.isDefault && addr.isActive && (
                    <button
                      type="button"
                      onClick={() => void handleSetDefault(addr.id)}
                      className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Make Default
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleToggleActive(addr)}
                    className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    {addr.isActive ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(addr.id)}
                    className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    aria-label={`Delete ${addr.email}`}
                  >
                    <Trash2 className="h-4 w-4" />
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
