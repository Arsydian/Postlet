/**
 * @file src/client/components/settings/SettingsView.tsx
 * @description Tabbed Settings workspace organizing Address configuration, Built-In Cloudflare
 * Workers AI Agent settings, Scoped Agent Keys, and the Audit Log.
 */

import { AtSign, Bot, ClipboardList, KeyRound, Menu } from "lucide-react";
import type { AddressRecord, AppSettings } from "../../../shared/types";
import { AddressesTab } from "./AddressesTab";
import { AgentKeysTab } from "./AgentKeysTab";
import { AiAgentTab } from "./AiAgentTab";
import { AuditLogTab } from "./AuditLogTab";

export type SettingsTabId = "addresses" | "ai" | "keys" | "audit";

interface SettingsViewProps {
  activeTab: SettingsTabId;
  settings: AppSettings;
  addresses: AddressRecord[];
  onTabChange: (tab: SettingsTabId) => void;
  onRefreshMeta: () => Promise<void>;
  onOpenMobileNav: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

const TABS: Array<{ id: SettingsTabId; label: string; icon: typeof AtSign }> = [
  { id: "addresses", label: "Addresses & Domain", icon: AtSign },
  { id: "ai", label: "AI Agent (Cloudflare AI)", icon: Bot },
  { id: "keys", label: "Agent Keys & MCP", icon: KeyRound },
  { id: "audit", label: "Audit Log", icon: ClipboardList },
];

export function SettingsView({
  activeTab,
  settings,
  addresses,
  onTabChange,
  onRefreshMeta,
  onOpenMobileNav,
  onSuccess,
  onError,
}: SettingsViewProps) {
  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-slate-50">
      <header className="border-b border-slate-200 bg-white px-5 pt-4">
        <div className="flex items-center gap-2.5 pb-3">
          <button
            type="button"
            onClick={onOpenMobileNav}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </button>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Settings</h1>
            <p className="text-xs text-slate-500">
              Manage custom addresses, Cloudflare AI automation, and external agent permissions.
            </p>
          </div>
        </div>

        <nav className="flex gap-1 overflow-x-auto" aria-label="Settings tabs">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onTabChange(id)}
                className={`inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-medium transition ${
                  active
                    ? "border-indigo-600 text-indigo-700"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
      </header>

      <div className="flex-1 overflow-y-auto p-5 lg:p-7">
        <div className="mx-auto max-w-4xl">
          {activeTab === "addresses" && (
            <AddressesTab
              settings={settings}
              addresses={addresses}
              onRefresh={onRefreshMeta}
              onSuccess={onSuccess}
              onError={onError}
            />
          )}
          {activeTab === "ai" && (
            <AiAgentTab
              settings={settings}
              onRefresh={onRefreshMeta}
              onSuccess={onSuccess}
              onError={onError}
            />
          )}
          {activeTab === "keys" && (
            <AgentKeysTab addresses={addresses} onSuccess={onSuccess} onError={onError} />
          )}
          {activeTab === "audit" && <AuditLogTab onError={onError} />}
        </div>
      </div>
    </div>
  );
}
