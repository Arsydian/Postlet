/**
 * @file src/client/components/Sidebar.tsx
 * @description Tactile Soft UI left navigation rail for Postlet: sculpted brand header, glowing
 * coral Compose CTA, mail folders with counts, Daily Digests, address filters, Dark Mode switch,
 * and Settings navigation.
 */

import {
  Archive,
  AtSign,
  Bot,
  Clock,
  FileText,
  Inbox,
  MailPlus,
  Moon,
  Send,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import type { AddressRecord, AppSettings, FolderCounts, FolderName } from "../../shared/types";
import type { ResolvedTheme, ThemePreference } from "../lib/theme";

export type ActiveSection = "mail" | "digests" | "settings";

interface SidebarProps {
  appVersion: string;
  ownerEmail: string;
  activeSection: ActiveSection;
  activeFolder: FolderName;
  selectedAddress: string | null;
  counts: FolderCounts;
  addresses: AddressRecord[];
  settings: AppSettings;
  mobileOpen: boolean;
  themePreference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  onToggleTheme: () => void;
  onCloseMobile: () => void;
  onCompose: () => void;
  onSelectFolder: (folder: FolderName) => void;
  onSelectAddress: (email: string | null) => void;
  onSelectSection: (section: ActiveSection, settingsTab?: "addresses" | "ai" | "keys" | "audit") => void;
}

const FOLDER_ITEMS: Array<{
  id: FolderName;
  label: string;
  icon: typeof Inbox;
}> = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "pending_approval", label: "Pending Approval", icon: Clock },
  { id: "sent", label: "Sent", icon: Send },
  { id: "drafts", label: "Drafts", icon: FileText },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "trash", label: "Trash", icon: Trash2 },
];

export function Sidebar({
  appVersion,
  ownerEmail,
  activeSection,
  activeFolder,
  selectedAddress,
  counts,
  addresses,
  settings,
  mobileOpen,
  themePreference,
  resolvedTheme,
  onToggleTheme,
  onCloseMobile,
  onCompose,
  onSelectFolder,
  onSelectAddress,
  onSelectSection,
}: SidebarProps) {
  function getFolderBadge(folder: FolderName): { count: number; amber?: boolean } | null {
    if (folder === "inbox" && counts.inboxUnread > 0) {
      return { count: counts.inboxUnread };
    }
    if (folder === "pending_approval" && counts.pendingApproval > 0) {
      return { count: counts.pendingApproval, amber: true };
    }
    if (folder === "drafts" && counts.drafts > 0) {
      return { count: counts.drafts };
    }
    return null;
  }

  const content = (
    <aside className="neu-panel flex h-full w-64 flex-col border-r border-[var(--neu-divider)]">
      {/* Brand header */}
      <div className="flex items-center justify-between border-b border-[var(--neu-divider)] px-4 py-3.5">
        <div className="flex items-center gap-3">
          <div className="neu-card relative flex h-9 w-9 items-center justify-center rounded-2xl text-sm font-bold text-[var(--neu-text)]">
            P
            <span
              className="neu-coral-dot absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full"
              aria-hidden="true"
            />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-base font-semibold tracking-tight text-[var(--neu-text)]">
                Postlet
              </span>
              <span className="neu-inset rounded-full px-2 py-0.5 text-[10px] font-medium text-[var(--neu-text-secondary)]">
                v{appVersion}
              </span>
            </div>
            <p
              className="max-w-[140px] truncate text-[11px] text-[var(--neu-text-muted)]"
              title={ownerEmail}
            >
              {ownerEmail}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onCloseMobile}
          className="neu-icon-btn h-8 w-8 lg:hidden"
          aria-label="Close navigation menu"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Compose CTA */}
      <div className="p-3.5">
        <button
          type="button"
          onClick={() => {
            onCompose();
            onCloseMobile();
          }}
          className="neu-btn-accent flex w-full items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold"
        >
          <MailPlus className="h-4 w-4" aria-hidden="true" />
          <span>Compose</span>
        </button>
      </div>

      {/* Main folders + Digests + Configured Addresses */}
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4" aria-label="Mailbox navigation">
        <div className="space-y-1">
          {FOLDER_ITEMS.map(({ id, label, icon: Icon }) => {
            const active = activeSection === "mail" && activeFolder === id;
            const badge = getFolderBadge(id);
            return (
              <button
                key={id}
                type="button"
                data-active={active}
                aria-current={active ? "page" : undefined}
                onClick={() => {
                  onSelectFolder(id);
                  onCloseMobile();
                }}
                className="neu-nav-item flex w-full items-center justify-between rounded-2xl py-2 pl-4 pr-3 text-sm font-medium"
              >
                <span className="flex items-center gap-2.5">
                  <Icon
                    className={`h-4 w-4 shrink-0 ${
                      active ? "text-[var(--neu-coral-text)]" : ""
                    }`}
                    aria-hidden="true"
                  />
                  <span>{label}</span>
                </span>
                {badge && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      badge.amber
                        ? "neu-badge-warning"
                        : active
                          ? "neu-badge-coral-solid"
                          : "neu-badge"
                    }`}
                  >
                    {badge.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* AI & Automation views */}
        <div className="space-y-1 border-t border-[var(--neu-divider)] pt-3.5">
          <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--neu-text-muted)]">
            Intelligence
          </div>
          <button
            type="button"
            data-active={activeSection === "digests"}
            aria-current={activeSection === "digests" ? "page" : undefined}
            onClick={() => {
              onSelectSection("digests");
              onCloseMobile();
            }}
            className="neu-nav-item flex w-full items-center justify-between rounded-2xl py-2 pl-4 pr-3 text-sm font-medium"
          >
            <span className="flex items-center gap-2.5">
              <Sparkles
                className={`h-4 w-4 shrink-0 ${
                  activeSection === "digests" ? "text-[var(--neu-coral-text)]" : ""
                }`}
                aria-hidden="true"
              />
              <span>Daily Digests</span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              onSelectSection("settings", "ai");
              onCloseMobile();
            }}
            className="neu-nav-item flex w-full items-center justify-between rounded-2xl py-2 pl-4 pr-3 text-sm font-medium"
          >
            <span className="flex items-center gap-2.5">
              <Bot className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Cloudflare AI</span>
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                settings.aiEnabled ? "neu-badge-success" : "neu-badge"
              }`}
            >
              {settings.aiEnabled ? "On" : "Off"}
            </span>
          </button>
        </div>

        {/* Configured Addresses filter */}
        <div className="space-y-1 border-t border-[var(--neu-divider)] pt-3.5">
          <div className="flex items-center justify-between px-3 pb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--neu-text-muted)]">
              Addresses
            </span>
            <button
              type="button"
              onClick={() => {
                onSelectSection("settings", "addresses");
                onCloseMobile();
              }}
              className="text-[11px] font-semibold text-[var(--neu-coral-text)] hover:underline"
            >
              Manage
            </button>
          </div>
          <button
            type="button"
            data-active={selectedAddress === null && activeSection === "mail"}
            onClick={() => {
              onSelectAddress(null);
              onCloseMobile();
            }}
            className="neu-nav-item flex w-full items-center gap-2 rounded-xl py-1.5 pl-4 pr-3 text-left text-xs font-medium"
          >
            <AtSign className="h-3.5 w-3.5 shrink-0 text-[var(--neu-text-muted)]" aria-hidden="true" />
            <span className="truncate">
              All {settings.mailDomain ? `(*@${settings.mailDomain})` : "Addresses"}
            </span>
          </button>
          {addresses
            .filter((a) => a.isActive)
            .map((addr) => {
              const activeAddr = selectedAddress === addr.email && activeSection === "mail";
              return (
                <button
                  key={addr.id}
                  type="button"
                  data-active={activeAddr}
                  onClick={() => {
                    onSelectAddress(addr.email);
                    onCloseMobile();
                  }}
                  className="neu-nav-item flex w-full items-center justify-between gap-2 rounded-xl py-1.5 pl-4 pr-3 text-left text-xs font-medium"
                >
                  <span className="truncate">{addr.email}</span>
                  {addr.isDefault && (
                    <span className="neu-badge-coral shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold">
                      default
                    </span>
                  )}
                </button>
              );
            })}
        </div>
      </nav>

      {/* Bottom Theme Toggle & Settings link */}
      <div className="space-y-2 border-t border-[var(--neu-divider)] p-3">
        <div className="neu-card rounded-2xl px-3">
          <label className="flex min-h-[44px] w-full cursor-pointer items-center justify-between gap-2 text-xs font-medium text-[var(--neu-text)] select-none">
            <span className="flex items-center gap-2">
              <span className="if-light items-center gap-2">
                <Sun className="h-4 w-4 shrink-0 text-[var(--neu-coral-text)]" aria-hidden="true" />
                <span>Light Mode</span>
              </span>
              <span className="if-dark items-center gap-2">
                <Moon className="h-4 w-4 shrink-0 text-[var(--neu-coral-text)]" aria-hidden="true" />
                <span>Dark Mode</span>
              </span>
              {themePreference === "system" && (
                <span className="neu-badge rounded-full px-1.5 py-0.5 text-[10px] font-medium">
                  Auto
                </span>
              )}
            </span>
            <input
              type="checkbox"
              role="switch"
              {...({ switch: "" } as Record<string, string>)}
              checked={resolvedTheme === "dark"}
              onChange={onToggleTheme}
              aria-label="Toggle dark mode"
              className="neu-switch"
            />
          </label>
        </div>

        <button
          type="button"
          data-active={activeSection === "settings"}
          aria-current={activeSection === "settings" ? "page" : undefined}
          onClick={() => {
            onSelectSection("settings");
            onCloseMobile();
          }}
          className="neu-nav-item flex w-full items-center gap-2.5 rounded-2xl py-2 pl-4 pr-3 text-sm font-medium"
        >
          <Settings
            className={`h-4 w-4 shrink-0 ${
              activeSection === "settings" ? "text-[var(--neu-coral-text)]" : ""
            }`}
            aria-hidden="true"
          />
          <span>Settings &amp; Agent API</span>
        </button>
      </div>
    </aside>
  );

  return (
    <>
      <div className="hidden h-full lg:block">{content}</div>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 backdrop-blur-xs"
            style={{ backgroundColor: "var(--neu-backdrop)" }}
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <div className="relative z-50 h-full">{content}</div>
        </div>
      )}
    </>
  );
}
