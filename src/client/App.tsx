/**
 * @file src/client/App.tsx
 * @description Root Postlet web application coordinating 3-pane mailbox navigation,
 * search, thread viewing, composer modal, Daily Digests, and Settings.
 */

import { AlertCircle, CheckCircle2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  AdminMetaResponse,
  FolderName,
  MessageRecord,
  ThreadDetail,
  ThreadSummary,
} from "../shared/types";
import { ComposerModal, type ComposerInitialState } from "./components/ComposerModal";
import { DailyDigestsView } from "./components/DailyDigestsView";
import { type ActiveSection, Sidebar } from "./components/Sidebar";
import { type SettingsTabId, SettingsView } from "./components/settings/SettingsView";
import { ThreadList } from "./components/ThreadList";
import { ThreadView } from "./components/ThreadView";
import { api } from "./lib/api";
import { useTheme } from "./lib/theme";

const PAGE_SIZE = 30;

export default function App() {
  const theme = useTheme();
  const [meta, setMeta] = useState<AdminMetaResponse | null>(null);
  const [activeSection, setActiveSection] = useState<ActiveSection>("mail");
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>("addresses");
  const [activeFolder, setActiveFolder] = useState<FolderName>("inbox");
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filterChip, setFilterChip] = useState<"all" | "unread" | "high" | "action_required">(
    "all",
  );

  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [threadsLoading, setThreadsLoading] = useState(false);

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] = useState<ThreadDetail | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const [composerOpen, setComposerOpen] = useState(false);
  const [composerInitial, setComposerInitial] = useState<ComposerInitialState | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [toast, setToast] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const showToast = useCallback((type: "success" | "error", text: string) => {
    setToast({ type, text });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Debounce full-text search queries to conserve D1 Free Tier reads.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 280);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const loadMeta = useCallback(async () => {
    try {
      const data = await api.getMeta();
      setMeta(data);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to initialize Postlet");
    }
  }, [showToast]);

  const loadThreads = useCallback(
    async (offset = 0, append = false) => {
      setThreadsLoading(true);
      try {
        const res = await api.listThreads({
          folder: activeFolder,
          address: selectedAddress || undefined,
          unread: filterChip === "unread" ? true : undefined,
          priority: filterChip === "high" ? "high" : undefined,
          category: filterChip === "action_required" ? "action_required" : undefined,
          q: debouncedQuery || undefined,
          limit: PAGE_SIZE,
          offset,
        });
        setThreads((prev) => (append ? [...prev, ...res.threads] : res.threads));
        setHasMore(res.threads.length === PAGE_SIZE);
      } catch (err) {
        showToast("error", err instanceof Error ? err.message : "Failed to load threads");
      } finally {
        setThreadsLoading(false);
      }
    },
    [activeFolder, selectedAddress, filterChip, debouncedQuery, showToast],
  );

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    if (activeSection === "mail") {
      void loadThreads(0, false);
    }
  }, [activeSection, loadThreads]);

  const openThread = useCallback(
    async (threadId: string) => {
      setSelectedThreadId(threadId);
      setActiveSection("mail");
      try {
        const res = await api.getThread(threadId);
        setSelectedThread(res.thread);
        if (res.thread.unreadCount > 0) {
          await api.updateThread(threadId, { isRead: true });
          setSelectedThread((cur) => (cur ? { ...cur, unreadCount: 0 } : cur));
          setThreads((prev) =>
            prev.map((t) => (t.id === threadId ? { ...t, unreadCount: 0 } : t)),
          );
          void loadMeta();
        }
      } catch (err) {
        showToast("error", err instanceof Error ? err.message : "Failed to open thread");
      }
    },
    [loadMeta, showToast],
  );

  async function refreshAll() {
    await Promise.all([loadMeta(), loadThreads(0, false)]);
    if (selectedThreadId) {
      const res = await api.getThread(selectedThreadId).catch(() => null);
      if (res) setSelectedThread(res.thread);
    }
  }

  async function handleMoveFolder(threadId: string, folder: "inbox" | "archive" | "trash") {
    setActionBusy(true);
    try {
      await api.updateThread(threadId, { folder });
      setSelectedThreadId(null);
      setSelectedThread(null);
      await refreshAll();
      showToast("success", `Moved conversation to ${folder}.`);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to move thread");
    } finally {
      setActionBusy(false);
    }
  }

  async function handleToggleUnread(threadId: string, currentlyUnread: boolean) {
    setActionBusy(true);
    try {
      await api.updateThread(threadId, { isRead: currentlyUnread });
      await refreshAll();
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to update read status");
    } finally {
      setActionBusy(false);
    }
  }

  async function handleDeletePermanent(threadId: string) {
    setActionBusy(true);
    try {
      await api.deleteThread(threadId);
      setSelectedThreadId(null);
      setSelectedThread(null);
      await refreshAll();
      showToast("success", "Thread permanently deleted.");
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to delete thread");
    } finally {
      setActionBusy(false);
    }
  }

  async function handleSummarize(threadId: string) {
    setAiBusy(true);
    try {
      await api.triageThread(threadId, true);
      await api.summarizeThread(threadId, true);
      await refreshAll();
      showToast("success", "Thread summary & triage updated.");
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "AI summary failed");
    } finally {
      setAiBusy(false);
    }
  }

  async function handleAutoReplyDraft(threadId: string) {
    setAiBusy(true);
    try {
      const res = await api.runImportantAutoReply(threadId, true);
      await refreshAll();
      showToast(
        "success",
        res.action === "sent"
          ? "AI auto-reply sent."
          : "AI reply queued in Pending Approval above.",
      );
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "AI auto-reply failed");
    } finally {
      setAiBusy(false);
    }
  }

  async function handleApprovePending(messageId: string) {
    setActionBusy(true);
    try {
      await api.approveMessage(messageId);
      await refreshAll();
      showToast("success", "Draft approved and sent via Resend.");
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to approve draft");
    } finally {
      setActionBusy(false);
    }
  }

  async function handleRejectPending(messageId: string) {
    setActionBusy(true);
    try {
      await api.rejectMessage(messageId);
      await refreshAll();
      showToast("success", "Pending draft rejected.");
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to reject draft");
    } finally {
      setActionBusy(false);
    }
  }

  function openNewCompose() {
    setComposerInitial({
      mode: "new",
      to: "",
      cc: "",
      bcc: "",
      subject: "",
      body: "",
    });
    setComposerOpen(true);
  }

  function openReply(msg: MessageRecord, replyAll: boolean) {
    const ownerEmails = new Set((meta?.addresses ?? []).map((a) => a.email.toLowerCase()));
    const primaryRecipient = msg.direction === "inbound" ? msg.replyTo || msg.fromAddress : msg.toAddresses[0] ?? "";
    const extraCc = replyAll
      ? [...msg.toAddresses, ...msg.ccAddresses]
          .filter((e) => !ownerEmails.has(e.toLowerCase()) && e.toLowerCase() !== primaryRecipient.toLowerCase())
          .join(", ")
      : "";

    setComposerInitial({
      mode: "reply",
      threadId: msg.threadId,
      replyToMessageId: msg.id,
      fromAddress: selectedThread?.recipientAddress || undefined,
      to: primaryRecipient,
      cc: extraCc,
      bcc: "",
      subject: /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`,
      body: "",
    });
    setComposerOpen(true);
  }

  function openForward(msg: MessageRecord) {
    setComposerInitial({
      mode: "forward",
      forwardMessageId: msg.id,
      fromAddress: selectedThread?.recipientAddress || undefined,
      to: "",
      cc: "",
      bcc: "",
      subject: /^fwd:/i.test(msg.subject) ? msg.subject : `Fwd: ${msg.subject}`,
      body: `\n\n---------- Forwarded message ---------\nFrom: ${msg.fromAddress}\nDate: ${msg.createdAt}\nSubject: ${msg.subject}\n\n${msg.textBody}`,
    });
    setComposerOpen(true);
  }

  function openEditPending(msg: MessageRecord) {
    setComposerInitial({
      mode: "approve_edit",
      pendingMessageId: msg.id,
      threadId: msg.threadId,
      fromAddress: msg.fromAddress,
      to: msg.toAddresses.join(", "),
      cc: msg.ccAddresses.join(", "),
      bcc: msg.bccAddresses.join(", "),
      subject: msg.subject,
      body: msg.textBody,
      htmlBody: msg.htmlBody,
      initialFormat: msg.htmlBody ? "rich" : "plain",
      trackOpensAndClicks: msg.headers["x-postlet-track"] === "true",
    });
    setComposerOpen(true);
  }

  function openEditDraft(msg: MessageRecord) {
    setComposerInitial({
      mode: "edit_draft",
      draftMessageId: msg.id,
      threadId: msg.threadId,
      fromAddress: msg.fromAddress,
      to: msg.toAddresses.join(", "),
      cc: msg.ccAddresses.join(", "),
      bcc: msg.bccAddresses.join(", "),
      subject: msg.subject,
      body: msg.textBody,
      htmlBody: msg.htmlBody,
      attachments: msg.attachments,
      initialFormat: msg.htmlBody ? "rich" : "plain",
      trackOpensAndClicks: msg.headers["x-postlet-track"] === "true",
    });
    setComposerOpen(true);
  }

  async function handleSendDraft(msg: MessageRecord) {
    setActionBusy(true);
    try {
      await api.updateDraftMessage(msg.id, {
        mode: "send",
        fromAddress: msg.fromAddress,
        to: msg.toAddresses,
        cc: msg.ccAddresses,
        bcc: msg.bccAddresses,
        subject: msg.subject,
        textBody: msg.textBody,
        htmlBody: msg.htmlBody,
        attachmentIds: msg.attachments.map((a) => a.id),
        trackOpensAndClicks: msg.headers["x-postlet-track"] === "true",
      });
      await refreshAll();
      showToast("success", "Draft sent via Resend.");
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to send draft");
    } finally {
      setActionBusy(false);
    }
  }

  async function handleDiscardDraft(messageId: string, threadId?: string) {
    setActionBusy(true);
    try {
      const res = await api.deleteDraftMessage(messageId);
      if (res.threadDeleted && selectedThreadId && (!threadId || selectedThreadId === threadId)) {
        setSelectedThreadId(null);
        setSelectedThread(null);
      }
      setComposerOpen(false);
      await refreshAll();
      showToast("success", "Draft discarded.");
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to discard draft");
    } finally {
      setActionBusy(false);
    }
  }

  if (!meta) {
    return (
      <div className="neu-canvas flex h-screen items-center justify-center p-6">
        <div className="neu-card flex items-center gap-3 rounded-3xl px-6 py-4">
          <div className="neu-btn-accent flex h-9 w-9 items-center justify-center rounded-2xl text-sm font-bold">
            P
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--neu-text)]">Loading Postlet…</p>
            <p className="text-xs text-[var(--neu-text-muted)]">Initializing mailbox &amp; theme</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="neu-canvas flex h-screen w-screen overflow-hidden">
      <Sidebar
        appVersion={meta.appVersion}
        ownerEmail={meta.ownerEmail}
        activeSection={activeSection}
        activeFolder={activeFolder}
        selectedAddress={selectedAddress}
        counts={meta.counts}
        addresses={meta.addresses}
        settings={meta.settings}
        mobileOpen={mobileNavOpen}
        themePreference={theme.preference}
        resolvedTheme={theme.resolvedTheme}
        onToggleTheme={theme.toggleTheme}
        onCloseMobile={() => setMobileNavOpen(false)}
        onCompose={openNewCompose}
        onSelectFolder={(folder) => {
          setActiveSection("mail");
          setActiveFolder(folder);
          setSelectedThreadId(null);
          setSelectedThread(null);
        }}
        onSelectAddress={(addr) => {
          setActiveSection("mail");
          setSelectedAddress(addr);
          setSelectedThreadId(null);
          setSelectedThread(null);
        }}
        onSelectSection={(sec, tab) => {
          setActiveSection(sec);
          if (tab) setSettingsTab(tab);
        }}
      />

      <main className="flex min-w-0 flex-1 overflow-hidden">
        {activeSection === "mail" && (
          <>
            <div
              className={`${
                selectedThread ? "hidden md:flex" : "flex"
              } h-full w-full md:w-auto`}
            >
              <ThreadList
                folder={activeFolder}
                selectedAddress={selectedAddress}
                threads={threads}
                selectedThreadId={selectedThreadId}
                loading={threadsLoading}
                searchQuery={searchQuery}
                filterChip={filterChip}
                hasMore={hasMore}
                onSearchChange={setSearchQuery}
                onFilterChipChange={setFilterChip}
                onSelectThread={(id) => void openThread(id)}
                onRefresh={() => void refreshAll()}
                onLoadMore={() => void loadThreads(threads.length, true)}
                onOpenMobileNav={() => setMobileNavOpen(true)}
              />
            </div>

            <div className={`${selectedThread ? "flex" : "hidden md:flex"} flex-1 h-full min-w-0`}>
              <ThreadView
                thread={selectedThread}
                settings={meta.settings}
                resolvedTheme={theme.resolvedTheme}
                aiBusy={aiBusy}
                actionBusy={actionBusy}
                onBackMobile={() => {
                  setSelectedThreadId(null);
                  setSelectedThread(null);
                }}
                onMoveFolder={(id, folder) => void handleMoveFolder(id, folder)}
                onToggleUnread={(id, unread) => void handleToggleUnread(id, unread)}
                onDeletePermanent={(id) => void handleDeletePermanent(id)}
                onReply={openReply}
                onForward={openForward}
                onSummarize={(id) => void handleSummarize(id)}
                onAutoReplyDraft={(id) => void handleAutoReplyDraft(id)}
                onApprovePending={(id) => void handleApprovePending(id)}
                onEditPending={openEditPending}
                onRejectPending={(id) => void handleRejectPending(id)}
                onEditDraft={openEditDraft}
                onSendDraft={(msg) => void handleSendDraft(msg)}
                onDiscardDraft={(msg) => void handleDiscardDraft(msg.id, msg.threadId)}
                onOpenAiSettings={() => {
                  setActiveSection("settings");
                  setSettingsTab("ai");
                }}
              />
            </div>
          </>
        )}

        {activeSection === "digests" && (
          <DailyDigestsView
            settings={meta.settings}
            onOpenThread={(id) => void openThread(id)}
            onOpenAiSettings={() => {
              setActiveSection("settings");
              setSettingsTab("ai");
            }}
            onOpenMobileNav={() => setMobileNavOpen(true)}
            onSuccess={(msg) => showToast("success", msg)}
            onError={(msg) => showToast("error", msg)}
          />
        )}

        {activeSection === "settings" && (
          <SettingsView
            activeTab={settingsTab}
            settings={meta.settings}
            addresses={meta.addresses}
            themePreference={theme.preference}
            systemTheme={theme.systemTheme}
            onSelectThemePreference={theme.setPreference}
            onTabChange={setSettingsTab}
            onRefreshMeta={loadMeta}
            onOpenMobileNav={() => setMobileNavOpen(true)}
            onSuccess={(msg) => showToast("success", msg)}
            onError={(msg) => showToast("error", msg)}
          />
        )}
      </main>

      <ComposerModal
        isOpen={composerOpen}
        initial={composerInitial}
        addresses={meta.addresses}
        settings={meta.settings}
        resolvedTheme={theme.resolvedTheme}
        onClose={() => setComposerOpen(false)}
        onDiscardDraft={handleDiscardDraft}
        onSuccess={(msg) => {
          showToast("success", msg);
          void refreshAll();
        }}
        onError={(msg) => showToast("error", msg)}
      />

      {toast && (
        <div
          role="status"
          className={`neu-card-lg fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-2xl px-4 py-3 text-xs font-semibold ${
            toast.type === "error"
              ? "border-[var(--neu-danger-border)] text-[var(--neu-danger-text)]"
              : "border-[var(--neu-success-border)] text-[var(--neu-success-text)]"
          }`}
        >
          {toast.type === "error" ? (
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  );
}
