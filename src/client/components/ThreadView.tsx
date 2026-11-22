/**
 * @file src/client/components/ThreadView.tsx
 * @description Full conversation thread reader with sandboxed sanitized HTML rendering,
 * R2 attachment downloads, delivery status timeline, Workers AI summary card, and Reply/Forward.
 */

import {
  Archive,
  ArrowLeft,
  Bot,
  Edit3,
  Forward,
  Inbox,
  MailOpen,
  Paperclip,
  Reply,
  ReplyAll,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { AppSettings, MessageRecord, ThreadDetail } from "../../shared/types";
import { buildEmailIframeSrcDoc, hasRemoteImages, sanitizeEmailHtml } from "../lib/sanitize";
import { ApprovalBanner } from "./ApprovalBanner";

interface ThreadViewProps {
  thread: ThreadDetail | null;
  settings: AppSettings;
  aiBusy: boolean;
  actionBusy: boolean;
  onBackMobile: () => void;
  onMoveFolder: (threadId: string, folder: "inbox" | "archive" | "trash") => void;
  onToggleUnread: (threadId: string, isRead: boolean) => void;
  onDeletePermanent: (threadId: string) => void;
  onReply: (message: MessageRecord, replyAll: boolean) => void;
  onForward: (message: MessageRecord) => void;
  onSummarize: (threadId: string) => void;
  onAutoReplyDraft: (threadId: string) => void;
  onApprovePending: (messageId: string) => void;
  onEditPending: (message: MessageRecord) => void;
  onRejectPending: (messageId: string) => void;
  onEditDraft: (message: MessageRecord) => void;
  onSendDraft: (message: MessageRecord) => void;
  onDiscardDraft: (message: MessageRecord) => void;
  onOpenAiSettings: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SanitizedEmailFrame({ htmlBody, textBody }: { htmlBody: string; textBody: string }) {
  const [srcDoc, setSrcDoc] = useState<string>("");
  const [viewMode, setViewMode] = useState<"html" | "text">(htmlBody ? "html" : "text");
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);

  const remoteImagesPresent = Boolean(htmlBody && hasRemoteImages(htmlBody));

  useEffect(() => {
    setAllowRemoteImages(false);
    setViewMode(htmlBody ? "html" : "text");
  }, [htmlBody]);

  useEffect(() => {
    let cancelled = false;
    if (!htmlBody) {
      setSrcDoc("");
      return;
    }
    void sanitizeEmailHtml(htmlBody).then((sanitized) => {
      if (!cancelled) {
        setSrcDoc(buildEmailIframeSrcDoc(sanitized, { allowRemoteImages }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [htmlBody, allowRemoteImages]);

  if (!htmlBody && !textBody) {
    return <p className="text-sm italic text-slate-400">(Empty message body)</p>;
  }

  return (
    <div>
      {(remoteImagesPresent || (htmlBody && textBody)) && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            {remoteImagesPresent && viewMode === "html" && !allowRemoteImages && (
              <div className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600">
                <span>Remote images blocked</span>
                <button
                  type="button"
                  onClick={() => setAllowRemoteImages(true)}
                  className="font-semibold text-indigo-600 hover:underline"
                >
                  Load images
                </button>
              </div>
            )}
          </div>
          {htmlBody && textBody && (
            <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => setViewMode("html")}
                className={`rounded px-2 py-0.5 font-medium ${
                  viewMode === "html" ? "bg-white text-slate-900 shadow-xs" : "text-slate-500"
                }`}
              >
                HTML
              </button>
              <button
                type="button"
                onClick={() => setViewMode("text")}
                className={`rounded px-2 py-0.5 font-medium ${
                  viewMode === "text" ? "bg-white text-slate-900 shadow-xs" : "text-slate-500"
                }`}
              >
                Plain Text
              </button>
            </div>
          )}
        </div>
      )}

      {viewMode === "html" && srcDoc ? (
        <iframe
          title="Sanitized email body"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          className="h-[380px] min-h-[180px] max-h-[1200px] w-full resize-y rounded-lg border border-slate-100 bg-white"
        />
      ) : (
        <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-800">
          {textBody}
        </pre>
      )}
    </div>
  );
}

export function ThreadView({
  thread,
  settings,
  aiBusy,
  actionBusy,
  onBackMobile,
  onMoveFolder,
  onToggleUnread,
  onDeletePermanent,
  onReply,
  onForward,
  onSummarize,
  onAutoReplyDraft,
  onApprovePending,
  onEditPending,
  onRejectPending,
  onEditDraft,
  onSendDraft,
  onDiscardDraft,
  onOpenAiSettings,
}: ThreadViewProps) {
  if (!thread) {
    return (
      <div className="hidden flex-1 flex-col items-center justify-center bg-slate-50/70 p-8 text-center md:flex">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
          <Inbox className="h-6 w-6" />
        </div>
        <h2 className="mt-3 text-base font-semibold text-slate-900">Select a conversation</h2>
        <p className="mt-1 max-w-sm text-xs text-slate-500">
          Pick an email thread on the left to inspect rich HTML content, attachments, delivery status,
          or pending AI agent drafts.
        </p>
      </div>
    );
  }

  const latestNonRejected = [...thread.messages]
    .reverse()
    .find(
      (m) => m.status !== "pending_approval" && m.status !== "rejected" && m.status !== "draft",
    );

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-slate-50/50">
      {/* Sticky Toolbar */}
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onBackMobile}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 md:hidden"
            aria-label="Back to thread list"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-slate-900">{thread.subject}</h2>
            <p className="truncate text-xs text-slate-500">
              Recipient: <span className="font-medium text-slate-700">{thread.recipientAddress}</span> ·{" "}
              {thread.messages.length} {thread.messages.length === 1 ? "message" : "messages"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {thread.folder !== "archive" && (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => onMoveFolder(thread.id, "archive")}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Archive className="h-3.5 w-3.5" />
              Archive
            </button>
          )}
          {thread.folder !== "inbox" && (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => onMoveFolder(thread.id, "inbox")}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Inbox className="h-3.5 w-3.5" />
              Move to Inbox
            </button>
          )}
          <button
            type="button"
            disabled={actionBusy}
            onClick={() => onToggleUnread(thread.id, thread.unreadCount > 0)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <MailOpen className="h-3.5 w-3.5" />
            {thread.unreadCount > 0 ? "Mark Read" : "Mark Unread"}
          </button>
          {thread.folder !== "trash" ? (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => onMoveFolder(thread.id, "trash")}
              className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-white px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Trash
            </button>
          ) : (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => onDeletePermanent(thread.id)}
              className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-rose-700"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete Forever
            </button>
          )}
        </div>
      </header>

      {/* Scrollable Body */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4 lg:p-6">
        {/* Built-in Cloudflare Workers AI Summary Card */}
        <div className="rounded-xl border border-indigo-100 bg-white p-4 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-indigo-600" />
              <span className="text-xs font-semibold uppercase tracking-wide text-indigo-900">
                Cloudflare AI Thread Brief
              </span>
              {thread.aiPriority && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                    thread.aiPriority === "high"
                      ? "bg-rose-100 text-rose-700"
                      : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {thread.aiPriority}
                </span>
              )}
              {thread.aiCategory && (
                <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
                  {thread.aiCategory.replace("_", " ")}
                </span>
              )}
            </div>

            {settings.aiEnabled ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={aiBusy}
                  onClick={() => onSummarize(thread.id)}
                  className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                >
                  <Bot className="h-3.5 w-3.5" />
                  {aiBusy ? "Thinking..." : thread.aiSummary ? "Refresh Summary" : "Summarize & Triage"}
                </button>
                <button
                  type="button"
                  disabled={aiBusy}
                  onClick={() => onAutoReplyDraft(thread.id)}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  Draft AI Reply
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={onOpenAiSettings}
                className="text-xs font-medium text-indigo-600 hover:text-indigo-700"
              >
                Enable Cloudflare AI in Settings →
              </button>
            )}
          </div>

          {thread.aiSummary ? (
            <p className="mt-2 whitespace-pre-line text-sm text-slate-700">{thread.aiSummary}</p>
          ) : (
            <p className="mt-1.5 text-xs text-slate-500">
              {settings.aiEnabled
                ? "Click Summarize & Triage to generate a cached Workers AI summary for this thread."
                : "Cloudflare Workers AI is currently disabled (default). Toggle it on in Settings when ready."}
            </p>
          )}
        </div>

        {/* Messages */}
        {thread.messages.map((msg) => {
          if (msg.status === "pending_approval") {
            return (
              <ApprovalBanner
                key={msg.id}
                message={msg}
                busy={actionBusy}
                onApprove={onApprovePending}
                onEdit={onEditPending}
                onReject={onRejectPending}
              />
            );
          }

          const isDraft = msg.status === "draft";
          const canRetryFailed = msg.status === "failed" && !msg.resendEmailId;

          return (
            <article
              key={msg.id}
              className={`rounded-xl border bg-white p-4 shadow-xs ${
                isDraft ? "border-indigo-200 ring-1 ring-indigo-100" : "border-slate-200"
              }`}
            >
              {isDraft && (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-indigo-200 bg-indigo-50/70 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                      Draft
                    </span>
                    <span className="text-xs font-medium text-indigo-950">
                      Saved draft — ready to edit or send
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => onEditDraft(msg)}
                      className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white shadow-xs hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                      Edit Draft
                    </button>
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => onSendDraft(msg)}
                      className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-xs hover:bg-emerald-700 disabled:opacity-50"
                    >
                      <Send className="h-3.5 w-3.5" />
                      Send Now
                    </button>
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => onDiscardDraft(msg)}
                      className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-white px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Discard
                    </button>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 pb-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900">
                      {msg.fromName ? `${msg.fromName} <${msg.fromAddress}>` : msg.fromAddress}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        msg.direction === "inbound"
                          ? "bg-slate-100 text-slate-600"
                          : "bg-indigo-50 text-indigo-700"
                      }`}
                    >
                      {msg.direction === "inbound" ? "Inbound" : `Outbound · ${msg.status}`}
                    </span>
                    {msg.createdByActor !== "inbound" && msg.createdByActor !== "owner" && (
                      <span className="rounded bg-purple-50 px-2 py-0.5 font-mono text-[10px] text-purple-700">
                        {msg.createdByActor}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    To: {msg.toAddresses.join(", ")}
                    {msg.ccAddresses.length > 0 ? ` · Cc: ${msg.ccAddresses.join(", ")}` : ""}
                  </p>
                </div>

                <div className="text-right">
                  <time className="text-xs text-slate-400">
                    {new Date(msg.createdAt).toLocaleString()}
                  </time>
                  {msg.deliveryError && (
                    <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
                      <p className="text-xs font-medium text-rose-600">{msg.deliveryError}</p>
                      {canRetryFailed && (
                        <button
                          type="button"
                          disabled={actionBusy}
                          onClick={() => onEditDraft(msg)}
                          className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                        >
                          <Edit3 className="h-3 w-3" />
                          Edit &amp; Retry
                        </button>
                      )}
                    </div>
                  )}
                  {!msg.deliveryError && canRetryFailed && (
                    <div className="mt-1 flex justify-end">
                      <button
                        type="button"
                        disabled={actionBusy}
                        onClick={() => onEditDraft(msg)}
                        className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                      >
                        <Edit3 className="h-3 w-3" />
                        Edit &amp; Retry
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-3">
                <SanitizedEmailFrame htmlBody={msg.htmlBody} textBody={msg.textBody} />
              </div>

              {/* R2 Attachments */}
              {msg.attachments.length > 0 && (
                <div className="mt-4 border-t border-slate-100 pt-3">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600">
                    <Paperclip className="h-3.5 w-3.5" />
                    Attachments ({msg.attachments.length})
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {msg.attachments.map((att) => (
                      <a
                        key={att.id}
                        href={`/api/admin/attachments/${encodeURIComponent(att.id)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
                      >
                        <Paperclip className="h-3 w-3 text-slate-400" />
                        <span className="max-w-[200px] truncate">{att.filename}</span>
                        <span className="text-slate-400">({formatBytes(att.sizeBytes)})</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* Delivery timeline for outbound messages */}
              {msg.deliveryEvents.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-2.5 text-[11px] text-slate-500">
                  {msg.deliveryEvents.map((ev, idx) => (
                    <span
                      key={`${ev.type}-${idx}`}
                      className="rounded bg-slate-50 px-2 py-0.5 border border-slate-100"
                    >
                      {ev.type} · {new Date(ev.timestamp).toLocaleTimeString()}
                      {ev.detail ? ` (${ev.detail})` : ""}
                    </span>
                  ))}
                </div>
              )}
            </article>
          );
        })}

        {/* Reply / Forward Bar */}
        {latestNonRejected && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => onReply(latestNonRejected, false)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-xs hover:bg-indigo-700"
            >
              <Reply className="h-3.5 w-3.5" />
              Reply
            </button>
            <button
              type="button"
              onClick={() => onReply(latestNonRejected, true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <ReplyAll className="h-3.5 w-3.5" />
              Reply All
            </button>
            <button
              type="button"
              onClick={() => onForward(latestNonRejected)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Forward className="h-3.5 w-3.5" />
              Forward
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
