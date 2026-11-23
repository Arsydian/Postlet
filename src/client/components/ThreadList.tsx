/**
 * @file src/client/components/ThreadList.tsx
 * @description Tactile Soft UI searchable thread list pane with debossed pill search well,
 * extruded triage filter chips, coral unread indicators, delivery badges, and pagination.
 */

import { Menu, RefreshCw, Search } from "lucide-react";
import type { FolderName, MessageStatus, ThreadSummary } from "../../shared/types";

interface ThreadListProps {
  folder: FolderName;
  selectedDomain: string | null;
  selectedAddress: string | null;
  showDomainPill?: boolean;
  threads: ThreadSummary[];
  selectedThreadId: string | null;
  loading: boolean;
  searchQuery: string;
  filterChip: "all" | "unread" | "high" | "action_required";
  hasMore: boolean;
  onSearchChange: (q: string) => void;
  onFilterChipChange: (chip: "all" | "unread" | "high" | "action_required") => void;
  onSelectThread: (threadId: string) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  onOpenMobileNav: () => void;
}

const FOLDER_TITLES: Record<FolderName, string> = {
  inbox: "Inbox",
  pending_approval: "Pending Approval",
  sent: "Sent",
  drafts: "Drafts",
  archive: "Archive",
  trash: "Trash",
};

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function StatusBadge({ status, hasPending }: { status: MessageStatus | null; hasPending: boolean }) {
  if (hasPending || status === "pending_approval") {
    return (
      <span className="neu-badge-warning rounded-full px-2 py-0.5 text-[10px] font-semibold">
        Needs Approval
      </span>
    );
  }
  if (!status || status === "received") return null;

  const styles: Record<string, string> = {
    delivered: "neu-badge-success",
    sent: "neu-badge-info",
    delayed: "neu-badge-warning",
    bounced: "neu-badge-danger",
    complained: "neu-badge-danger",
    failed: "neu-badge-danger",
    draft: "neu-badge",
  };
  const cls = styles[status];
  if (!cls) return null;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${cls}`}>
      {status}
    </span>
  );
}

export function ThreadList({
  folder,
  selectedDomain,
  selectedAddress,
  showDomainPill = false,
  threads,
  selectedThreadId,
  loading,
  searchQuery,
  filterChip,
  hasMore,
  onSearchChange,
  onFilterChipChange,
  onSelectThread,
  onRefresh,
  onLoadMore,
  onOpenMobileNav,
}: ThreadListProps) {
  return (
    <section
      className="neu-panel postlet-thread-list-pane flex h-full shrink-0 flex-col border-r border-[var(--neu-divider)]"
      aria-label="Conversation threads"
    >
      {/* Header + Debossed Search Well */}
      <div className="border-b border-[var(--neu-divider)] px-4 py-3.5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <button
              type="button"
              onClick={onOpenMobileNav}
              className="neu-icon-btn postlet-mobile-nav-trigger h-8 w-8 shrink-0"
              aria-label="Open menu"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div>
              <h1 className="text-base font-semibold text-[var(--neu-text)]">
                {FOLDER_TITLES[folder]}
              </h1>
              {(selectedAddress || selectedDomain) && (
                <p className="text-[11px] font-semibold text-[var(--neu-coral-text)]">
                  {selectedAddress || `*@${selectedDomain}`}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="neu-icon-btn h-8 w-8"
            title="Refresh"
            aria-label="Refresh threads"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Sculpted outer bezel + debossed search well matching reference hardware styling */}
        <div className="neu-search-bezel">
          <div className="neu-search-well">
            <Search
              className="pointer-events-none ml-3 h-4 w-4 shrink-0 text-[var(--neu-text-muted)]"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search mail (subject, sender, body)..."
              aria-label="Search mail"
              className="w-full bg-transparent py-1.5 pl-2.5 pr-3.5 text-sm text-[var(--neu-text)] focus:outline-none"
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {(
            [
              { id: "all", label: "All" },
              { id: "unread", label: "Unread" },
              { id: "high", label: "High Priority" },
              { id: "action_required", label: "Action Required" },
            ] as const
          ).map((chip) => {
            const active = filterChip === chip.id;
            return (
              <button
                key={chip.id}
                type="button"
                aria-pressed={active}
                onClick={() => onFilterChipChange(chip.id)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  active ? "neu-btn-accent" : "neu-btn text-[var(--neu-text-secondary)]"
                }`}
              >
                {chip.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tactile Thread Cards */}
      <div className="postlet-scroll-region flex-1 space-y-2.5 overflow-y-auto p-3">
        {threads.length === 0 && !loading ? (
          <div className="neu-card flex h-56 flex-col items-center justify-center rounded-2xl px-6 text-center">
            <p className="text-sm font-semibold text-[var(--neu-text)]">No conversations here</p>
            <p className="mt-1 text-xs text-[var(--neu-text-muted)]">
              {searchQuery
                ? "Try adjusting your search keywords or filters."
                : "Incoming Resend emails and sent messages will appear here."}
            </p>
          </div>
        ) : (
          threads.map((thread) => {
            const isSelected = thread.id === selectedThreadId;
            const isUnread = thread.unreadCount > 0;
            const displayParticipants =
              thread.participants.filter((p) => p !== thread.recipientAddress).join(", ") ||
              thread.participants[0] ||
              "Unknown";

            return (
              <button
                key={thread.id}
                type="button"
                data-selected={isSelected}
                aria-current={isSelected ? "true" : undefined}
                onClick={() => onSelectThread(thread.id)}
                className="neu-thread-card block w-full rounded-2xl p-3.5 text-left"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {isUnread && (
                      <span
                        className="neu-coral-dot h-2.5 w-2.5 shrink-0 rounded-full"
                        title="Unread"
                      />
                    )}
                    <span
                      className={`truncate text-sm ${
                        isUnread
                          ? "font-semibold text-[var(--neu-text)]"
                          : "font-medium text-[var(--neu-text-secondary)]"
                      }`}
                    >
                      {displayParticipants}
                    </span>
                  </div>
                  <span className="shrink-0 text-[11px] text-[var(--neu-text-muted)]">
                    {formatShortDate(thread.lastMessageAt)}
                  </span>
                </div>

                <div className="mt-1 flex items-center justify-between gap-2">
                  <p
                    className={`truncate text-sm ${
                      isUnread
                        ? "font-semibold text-[var(--neu-text)]"
                        : "font-normal text-[var(--neu-text)]"
                    }`}
                  >
                    {thread.subject}
                  </p>
                  {thread.messageCount > 1 && (
                    <span className="neu-badge shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold">
                      {thread.messageCount}
                    </span>
                  )}
                </div>

                <p className="mt-1 line-clamp-2 text-xs text-[var(--neu-text-secondary)]">
                  {thread.snippet}
                </p>

                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <StatusBadge
                    status={thread.latestStatus}
                    hasPending={thread.hasPendingApproval}
                  />
                  {thread.aiPriority === "high" && (
                    <span className="neu-badge-danger rounded-full px-2 py-0.5 text-[10px] font-semibold">
                      High Priority
                    </span>
                  )}
                  {thread.aiCategory && (
                    <span className="neu-badge-coral rounded-full px-2 py-0.5 text-[10px] font-medium">
                      {thread.aiCategory.replace("_", " ")}
                    </span>
                  )}
                  {showDomainPill && thread.recipientAddress.includes("@") && (
                    <span className="neu-badge rounded-full px-2 py-0.5 text-[10px] font-medium">
                      {thread.recipientAddress.split("@")[1]}
                    </span>
                  )}
                </div>
              </button>
            );
          })
        )}

        {hasMore && (
          <div className="pt-1 pb-2 text-center">
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loading}
              className="neu-btn rounded-full px-4 py-1.5 text-xs font-medium text-[var(--neu-text)]"
            >
              {loading ? "Loading..." : "Load more threads"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
