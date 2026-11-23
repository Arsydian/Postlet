/**
 * @file src/client/components/settings/SettingsView.tsx
 * @description Tactile Soft UI tabbed Settings workspace organizing Appearance preference,
 * Address configuration, Built-In Cloudflare Workers AI Agent settings, Scoped Agent Keys,
 * and the Audit Log.
 */

import { AtSign, Bot, ClipboardList, KeyRound, Menu, Monitor, Moon, Sun } from "lucide-react";
import type { AddressRecord, AppSettings, MailProviderId } from "../../../shared/types";
import type { ResolvedTheme, ThemePreference } from "../../lib/theme";
import { AddressesTab } from "./AddressesTab";
import { AgentKeysTab } from "./AgentKeysTab";
import { AiAgentTab } from "./AiAgentTab";
import { AuditLogTab } from "./AuditLogTab";

export type SettingsTabId = "addresses" | "ai" | "keys" | "audit";

interface SettingsViewProps {
  activeTab: SettingsTabId;
  settings: AppSettings;
  addresses: AddressRecord[];
  mailProvider: MailProviderId;
  selfHostedTrackingEnabled: boolean;
  themePreference: ThemePreference;
  systemTheme: ResolvedTheme;
  onSelectThemePreference: (pref: ThemePreference) => void;
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
  mailProvider,
  selfHostedTrackingEnabled,
  themePreference,
  systemTheme,
  onSelectThemePreference,
  onTabChange,
  onRefreshMeta,
  onOpenMobileNav,
  onSuccess,
  onError,
}: SettingsViewProps) {
  return (
    <div className="neu-canvas flex h-full flex-1 flex-col overflow-hidden">
      <header className="neu-panel border-b border-[var(--neu-divider)] px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onOpenMobileNav}
              className="neu-icon-btn postlet-mobile-nav-trigger h-8 w-8"
              aria-label="Open menu"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div>
              <h1 className="text-lg font-semibold text-[var(--neu-text)]">Settings</h1>
              <p className="text-xs text-[var(--neu-text-muted)]">
                Manage appearance, custom addresses, Cloudflare AI automation, and external agent
                permissions.
              </p>
            </div>
          </div>

          {/* 3-State Appearance Switcher (System / Light / Dark) per modern-web-guidance */}
          <div
            className="neu-segmented flex-wrap text-xs"
            role="group"
            aria-label="Color theme preference"
          >
            <button
              type="button"
              data-active={themePreference === "system"}
              aria-pressed={themePreference === "system"}
              onClick={() => onSelectThemePreference("system")}
              className="neu-segmented-btn px-3 py-1.5 font-medium"
            >
              <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
              <span>System ({systemTheme === "dark" ? "Dark" : "Light"})</span>
            </button>
            <button
              type="button"
              data-active={themePreference === "light"}
              aria-pressed={themePreference === "light"}
              onClick={() => onSelectThemePreference("light")}
              className="neu-segmented-btn px-3 py-1.5 font-medium"
            >
              <Sun className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Light</span>
            </button>
            <button
              type="button"
              data-active={themePreference === "dark"}
              aria-pressed={themePreference === "dark"}
              onClick={() => onSelectThemePreference("dark")}
              className="neu-segmented-btn px-3 py-1.5 font-medium"
            >
              <Moon className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Dark</span>
            </button>
          </div>
        </div>

        {/* Sculpted Segmented Tab Bar matching reference hardware pill strip */}
        <nav className="overflow-x-auto pb-0.5" aria-label="Settings tabs">
          <div className="neu-segmented text-xs">
            {TABS.map(({ id, label, icon: Icon }) => {
              const active = activeTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  data-active={active}
                  aria-current={active ? "page" : undefined}
                  onClick={() => onTabChange(id)}
                  className="neu-segmented-btn shrink-0 px-3.5 py-1.5 font-medium"
                >
                  <Icon
                    className={`h-3.5 w-3.5 ${
                      active ? "text-[var(--neu-coral-text)]" : ""
                    }`}
                    aria-hidden="true"
                  />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </nav>
      </header>

      <div className="postlet-scroll-region flex-1 overflow-y-auto p-5 lg:p-7">
        <div className="mx-auto max-w-4xl">
          {activeTab === "addresses" && (
            <AddressesTab
              settings={settings}
              addresses={addresses}
              mailProvider={mailProvider}
              selfHostedTrackingEnabled={selfHostedTrackingEnabled}
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
