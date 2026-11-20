/**
 * @file src/client/components/Sidebar.tsx
 * @description Left navigation rail for Postlet: Compose action, mail folders with counts,
 * Daily Digests & Settings navigation, configured address filters, and Cloudflare AI status pill.
 */

import {
  Archive,
  AtSign,
  Bot,
  Clock,
  FileText,
  Inbox,
  MailPlus,
  Send,
  Settings,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { AddressRecord, AppSettings, FolderCounts, FolderName } from "../../shared/types";

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
    <aside className="flex h-full w-64 flex-col border-r border-slate-200 bg-white">
      {/* Brand header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white shadow-sm">
            P
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-base font-semibold tracking-tight text-slate-900">Postlet</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                v{appVersion}
              </span>
            </div>
            <p className="max-w-[140px] truncate text-[11px] text-slate-500" title={ownerEmail}>
              {ownerEmail}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onCloseMobile}
          className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 lg:hidden"
          aria-label="Close navigation menu"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Compose CTA */}
      <div className="p-3">
        <button
          type="button"
          onClick={() => {
            onCompose();
            onCloseMobile();
          }}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 active:scale-[0.99]"
        >
          <MailPlus className="h-4 w-4" />
          <span>Compose</span>
        </button>
      </div>

      {/* Main folders + Digests + Configured Addresses */}
      <nav className="flex-1 space-y-5 overflow-y-auto px-2.5 pb-4" aria-label="Mailbox navigation">
        <div className="space-y-0.5">
          {FOLDER_ITEMS.map(({ id, label, icon: Icon }) => {
            const active = activeSection === "mail" && activeFolder === id;
            const badge = getFolderBadge(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  onSelectFolder(id);
                  onCloseMobile();
                }}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition ${
                  active
                    ? "bg-indigo-50 text-indigo-700"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{label}</span>
                </span>
                {badge && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      badge.amber
                        ? "bg-amber-100 text-amber-800"
                        : active
                          ? "bg-indigo-600 text-white"
                          : "bg-slate-200 text-slate-700"
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
        <div className="space-y-0.5 border-t border-slate-100 pt-3">
          <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Intelligence
          </div>
          <button
            type="button"
            onClick={() => {
              onSelectSection("digests");
              onCloseMobile();
            }}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition ${
              activeSection === "digests"
                ? "bg-indigo-50 text-indigo-700"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Sparkles className="h-4 w-4 shrink-0" />
              <span>Daily Digests</span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              onSelectSection("settings", "ai");
              onCloseMobile();
            }}
            className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          >
            <span className="flex items-center gap-2.5">
              <Bot className="h-4 w-4 shrink-0" />
              <span>Cloudflare AI</span>
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                settings.aiEnabled
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-slate-100 text-slate-500"
              }`}
            >
              {settings.aiEnabled ? "On" : "Off"}
            </span>
          </button>
        </div>

        {/* Configured Addresses filter */}
        <div className="space-y-0.5 border-t border-slate-100 pt-3">
          <div className="flex items-center justify-between px-3 pb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Addresses
            </span>
            <button
              type="button"
              onClick={() => {
                onSelectSection("settings", "addresses");
                onCloseMobile();
              }}
              className="text-[11px] font-medium text-indigo-600 hover:text-indigo-700"
            >
              Manage
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              onSelectAddress(null);
              onCloseMobile();
            }}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs font-medium transition ${
              selectedAddress === null && activeSection === "mail"
                ? "bg-slate-100 text-slate-900"
                : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            <AtSign className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="truncate">
              All {settings.mailDomain ? `(*@${settings.mailDomain})` : "Addresses"}
            </span>
          </button>
          {addresses
            .filter((a) => a.isActive)
            .map((addr) => (
              <button
                key={addr.id}
                type="button"
                onClick={() => {
                  onSelectAddress(addr.email);
                  onCloseMobile();
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition ${
                  selectedAddress === addr.email && activeSection === "mail"
                    ? "bg-indigo-50 font-semibold text-indigo-700"
                    : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                <span className="truncate">{addr.email}</span>
                {addr.isDefault && (
                  <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                    default
                  </span>
                )}
              </button>
            ))}
        </div>
      </nav>

      {/* Bottom Settings link */}
      <div className="border-t border-slate-100 p-2.5">
        <button
          type="button"
          onClick={() => {
            onSelectSection("settings");
            onCloseMobile();
          }}
          className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
            activeSection === "settings"
              ? "bg-indigo-50 text-indigo-700"
              : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          }`}
        >
          <Settings className="h-4 w-4" />
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
            className="fixed inset-0 bg-slate-900/40"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <div className="relative z-50 h-full">{content}</div>
        </div>
      )}
    </>
  );
}
