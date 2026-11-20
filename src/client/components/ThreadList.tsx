/**
 * @file src/client/components/ThreadList.tsx
 * @description Searchable thread list pane with AI triage filter chips, unread indicators,
 * delivery status badges, and pagination.
 */

import { Menu, RefreshCw, Search } from "lucide-react";
import type { FolderName, MessageStatus, ThreadSummary } from "../../shared/types";

interface ThreadListProps {
  folder: FolderName;
  selectedAddress: string | null;
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
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
        Needs Approval
      </span>
    );
  }
  if (!status || status === "received") return null;

  const styles: Record<string, string> = {
    delivered: "bg-emerald-50 text-emerald-700 border border-emerald-200",
    sent: "bg-sky-50 text-sky-700 border border-sky-200",
    delayed: "bg-amber-50 text-amber-700 border border-amber-200",
    bounced: "bg-rose-50 text-rose-700 border border-rose-200",
    complained: "bg-rose-50 text-rose-700 border border-rose-200",
    failed: "bg-rose-50 text-rose-700 border border-rose-200",
    draft: "bg-slate-100 text-slate-600",
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
  selectedAddress,
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
      className="flex h-full w-full flex-col border-r border-slate-200 bg-white md:w-88 lg:w-96 shrink-0"
      aria-label="Conversation threads"
    >
      {/* Header + Search */}
      <div className="border-b border-slate-200 px-3.5 py-3">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenMobileNav}
              className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden"
              aria-label="Open menu"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div>
              <h1 className="text-base font-semibold text-slate-900">
                {FOLDER_TITLES[folder]}
              </h1>
              {selectedAddress && (
                <p className="text-[11px] font-medium text-indigo-600">{selectedAddress}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-lg border border-slate-200 p-1.5 text-slate-500 transition hover:bg-slate-50 hover:text-slate-800"
            title="Refresh"
            aria-label="Refresh threads"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search mail (subject, sender, body)..."
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none"
          />
        </div>

        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {(
            [
              { id: "all", label: "All" },
              { id: "unread", label: "Unread" },
              { id: "high", label: "High Priority" },
              { id: "action_required", label: "Action Required" },
            ] as const
          ).map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => onFilterChipChange(chip.id)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                filterChip === chip.id
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      {/* Thread rows */}
      <div className="flex-1 divide-y divide-slate-100 overflow-y-auto">
        {threads.length === 0 && !loading ? (
          <div className="flex h-56 flex-col items-center justify-center px-6 text-center">
            <p className="text-sm font-medium text-slate-700">No conversations here</p>
            <p className="mt-1 text-xs text-slate-500">
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
                onClick={() => onSelectThread(thread.id)}
                className={`block w-full px-4 py-3 text-left transition ${
                  isSelected
                    ? "bg-indigo-50/80"
                    : isUnread
                      ? "bg-white hover:bg-slate-50"
                      : "bg-slate-50/30 hover:bg-slate-50"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {isUnread && (
                      <span
                        className="h-2 w-2 shrink-0 rounded-full bg-indigo-600"
                        title="Unread"
                      />
                    )}
                    <span
                      className={`truncate text-sm ${
                        isUnread ? "font-semibold text-slate-900" : "font-medium text-slate-700"
                      }`}
                    >
                      {displayParticipants}
                    </span>
                  </div>
                  <span className="shrink-0 text-[11px] text-slate-400">
                    {formatShortDate(thread.lastMessageAt)}
                  </span>
                </div>

                <div className="mt-0.5 flex items-center justify-between gap-2">
                  <p
                    className={`truncate text-sm ${
                      isUnread ? "font-semibold text-slate-900" : "font-normal text-slate-800"
                    }`}
                  >
                    {thread.subject}
                  </p>
                  {thread.messageCount > 1 && (
                    <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                      {thread.messageCount}
                    </span>
                  )}
                </div>

                <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{thread.snippet}</p>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <StatusBadge
                    status={thread.latestStatus}
                    hasPending={thread.hasPendingApproval}
                  />
                  {thread.aiPriority === "high" && (
                    <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700">
                      High Priority
                    </span>
                  )}
                  {thread.aiCategory && (
                    <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
                      {thread.aiCategory.replace("_", " ")}
                    </span>
                  )}
                </div>
              </button>
            );
          })
        )}

        {hasMore && (
          <div className="p-3 text-center">
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loading}
              className="rounded-lg border border-slate-200 px-4 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {loading ? "Loading..." : "Load more threads"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
