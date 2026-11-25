/**
 * @file src/client/components/ThreadView.tsx
 * @description Tactile Soft UI conversation thread reader with theme-aware sandboxed sanitized HTML
 * rendering, R2 attachment downloads, delivery status timeline, Workers AI brief card, and Reply/Forward.
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
  Sun,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  AppSettings,
  AttachmentRecord,
  MessageRecord,
  ThreadDetail,
} from "../../shared/types";
import {
  buildEmailIframeSrcDoc,
  hasRemoteImages,
  matchCidAttachments,
  SAFE_INLINE_IMAGE_MIMES,
  sanitizeEmailHtml,
} from "../lib/sanitize";
import type { ResolvedTheme } from "../lib/theme";
import { ApprovalBanner } from "./ApprovalBanner";

const MAX_CID_CACHE_ENTRIES = 60;
const cidDataUriCache = new Map<string, Promise<string | null>>();

function encodeUint8ArrayToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function loadCidAttachmentDataUri(attachment: AttachmentRecord): Promise<string | null> {
  const cached = cidDataUriCache.get(attachment.id);
  if (cached) {
    return cached;
  }

  if (cidDataUriCache.size >= MAX_CID_CACHE_ENTRIES) {
    const oldestKey = cidDataUriCache.keys().next().value;
    if (oldestKey !== undefined) {
      cidDataUriCache.delete(oldestKey);
    }
  }

  const pending = (async (): Promise<string | null> => {
    try {
      const res = await fetch(`/api/admin/attachments/${encodeURIComponent(attachment.id)}?inline=true`, {
        credentials: "same-origin",
      });
      if (!res.ok) {
        cidDataUriCache.delete(attachment.id);
        return null;
      }
      const mime = (res.headers.get("Content-Type") || attachment.contentType || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (!SAFE_INLINE_IMAGE_MIMES.has(mime)) {
        return null;
      }
      const buf = await res.arrayBuffer();
      return `data:${mime};base64,${encodeUint8ArrayToBase64(new Uint8Array(buf))}`;
    } catch {
      cidDataUriCache.delete(attachment.id);
      return null;
    }
  })();

  cidDataUriCache.set(attachment.id, pending);
  return pending;
}

interface ThreadViewProps {
  thread: ThreadDetail | null;
  settings: AppSettings;
  resolvedTheme: ResolvedTheme;
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
  onAllowMessageImages: (messageId: string) => void;
  onTrustSenderImages: (senderEmail: string, messageId: string) => void;
  onOpenAiSettings: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SanitizedEmailFrame({
  messageId,
  senderEmail,
  htmlBody,
  textBody,
  attachments,
  resolvedTheme,
  persistedAllowImages,
  isSenderTrusted,
  onAllowImages,
  onTrustSender,
}: {
  messageId: string;
  senderEmail: string;
  htmlBody: string;
  textBody: string;
  attachments: AttachmentRecord[];
  resolvedTheme: ResolvedTheme;
  persistedAllowImages: boolean;
  isSenderTrusted: boolean;
  onAllowImages: () => void;
  onTrustSender: () => void;
}) {
  const [srcDoc, setSrcDoc] = useState<string>("");
  const [viewMode, setViewMode] = useState<"html" | "text">(htmlBody ? "html" : "text");
  const [localAllowOverride, setLocalAllowOverride] = useState(false);
  const [forceLightPaper, setForceLightPaper] = useState(false);

  const remoteImagesPresent = Boolean(htmlBody && hasRemoteImages(htmlBody));
  const effectiveAllowImages = persistedAllowImages || localAllowOverride;
  const iframeTheme: ResolvedTheme = forceLightPaper ? "light" : resolvedTheme;

  useEffect(() => {
    setLocalAllowOverride(false);
    setForceLightPaper(false);
    setViewMode(htmlBody ? "html" : "text");
  }, [messageId]);

  useEffect(() => {
    let cancelled = false;
    if (!htmlBody) {
      setSrcDoc("");
      return;
    }

    const cidMatches = matchCidAttachments(htmlBody, attachments);
    const loadAll = async () => {
      const [sanitized, cidEntries] = await Promise.all([
        sanitizeEmailHtml(htmlBody),
        Promise.all(
          cidMatches.map(async ({ cidKey, attachment }) => {
            const uri = await loadCidAttachmentDataUri(attachment);
            return uri ? ([cidKey, uri] as const) : null;
          }),
        ),
      ]);
      if (cancelled) return;
      const cidDataUris = new Map<string, string>();
      for (const entry of cidEntries) {
        if (entry) {
          cidDataUris.set(entry[0], entry[1]);
        }
      }
      setSrcDoc(
        buildEmailIframeSrcDoc(sanitized, {
          allowRemoteImages: effectiveAllowImages,
          theme: iframeTheme,
          cidDataUris,
        }),
      );
    };

    void loadAll();
    return () => {
      cancelled = true;
    };
  }, [htmlBody, attachments, effectiveAllowImages, iframeTheme]);

  if (!htmlBody && !textBody) {
    return <p className="text-sm italic text-[var(--neu-text-muted)]">(Empty message body)</p>;
  }

  return (
    <div>
      {(remoteImagesPresent || (htmlBody && textBody) || (resolvedTheme === "dark" && htmlBody)) && (
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {remoteImagesPresent && viewMode === "html" && !effectiveAllowImages && (
              <div className="neu-inset inline-flex flex-wrap items-center gap-2 rounded-full px-3 py-1 text-[11px] text-[var(--neu-text-secondary)]">
                <span>Remote images blocked</span>
                <button
                  type="button"
                  onClick={() => {
                    setLocalAllowOverride(true);
                    onAllowImages();
                  }}
                  className="font-semibold text-[var(--neu-coral-text)] hover:underline"
                >
                  Allow images
                </button>
                {senderEmail && !isSenderTrusted && (
                  <>
                    <span className="text-[var(--neu-text-muted)]" aria-hidden="true">
                      ·
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setLocalAllowOverride(true);
                        onTrustSender();
                      }}
                      className="font-medium text-[var(--neu-text-secondary)] hover:text-[var(--neu-text)] hover:underline"
                    >
                      Always allow {senderEmail}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {resolvedTheme === "dark" && viewMode === "html" && Boolean(htmlBody) && (
              <button
                type="button"
                aria-pressed={forceLightPaper}
                onClick={() => setForceLightPaper((v) => !v)}
                className="neu-btn inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium text-[var(--neu-text-secondary)]"
                title="Switch email canvas between dark and light paper for bright third-party emails"
              >
                <Sun className="h-3 w-3" aria-hidden="true" />
                {forceLightPaper ? "Dark Canvas" : "Light Paper"}
              </button>
            )}

            {htmlBody && textBody && (
              <div className="neu-segmented text-[11px]">
                <button
                  type="button"
                  data-active={viewMode === "html"}
                  onClick={() => setViewMode("html")}
                  className="neu-segmented-btn px-2.5 py-0.5 font-medium"
                >
                  HTML
                </button>
                <button
                  type="button"
                  data-active={viewMode === "text"}
                  onClick={() => setViewMode("text")}
                  className="neu-segmented-btn px-2.5 py-0.5 font-medium"
                >
                  Plain Text
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {viewMode === "html" && srcDoc ? (
        <iframe
          key={`${messageId}-${effectiveAllowImages ? "img-on" : "img-off"}-${iframeTheme}`}
          title="Sanitized email body"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          className="postlet-email-frame w-full resize-y rounded-xl border border-[var(--neu-border)] bg-[var(--neu-inset)]"
        />
      ) : (
        <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-[var(--neu-text)]">
          {textBody}
        </pre>
      )}
    </div>
  );
}

export function ThreadView({
  thread,
  settings,
  resolvedTheme,
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
  onAllowMessageImages,
  onTrustSenderImages,
  onOpenAiSettings,
}: ThreadViewProps) {
  if (!thread) {
    return (
      <div className="neu-canvas flex flex-1 flex-col items-center justify-center p-8 text-center">
        <div className="neu-card max-w-sm rounded-3xl p-8">
          <div className="neu-inset mx-auto flex h-14 w-14 items-center justify-center rounded-full text-[var(--neu-coral-text)]">
            <Inbox className="h-6 w-6" aria-hidden="true" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-[var(--neu-text)]">
            Select a conversation
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-[var(--neu-text-muted)]">
            Pick an email thread on the left to inspect rich HTML content, attachments, delivery
            status, or pending AI agent drafts.
          </p>
        </div>
      </div>
    );
  }

  const latestNonRejected = [...thread.messages]
    .reverse()
    .find(
      (m) => m.status !== "pending_approval" && m.status !== "rejected" && m.status !== "draft",
    );

  return (
    <div className="neu-canvas flex h-full flex-1 flex-col overflow-hidden">
      {/* Sticky Toolbar */}
      <header className="neu-panel flex flex-wrap items-center justify-between gap-2 border-b border-[var(--neu-divider)] px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={onBackMobile}
            className="neu-icon-btn postlet-back-btn h-8 w-8 shrink-0"
            aria-label="Back to thread list"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-[var(--neu-text)]">
              {thread.subject}
            </h2>
            <p className="truncate text-xs text-[var(--neu-text-muted)]">
              Recipient:{" "}
              <span className="font-medium text-[var(--neu-text-secondary)]">
                {thread.recipientAddress}
              </span>{" "}
              · {thread.messages.length} {thread.messages.length === 1 ? "message" : "messages"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {thread.folder !== "archive" && (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => onMoveFolder(thread.id, "archive")}
              className="neu-btn inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium"
            >
              <Archive className="h-3.5 w-3.5" aria-hidden="true" />
              Archive
            </button>
          )}
          {thread.folder !== "inbox" && (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => onMoveFolder(thread.id, "inbox")}
              className="neu-btn inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium"
            >
              <Inbox className="h-3.5 w-3.5" aria-hidden="true" />
              Move to Inbox
            </button>
          )}
          <button
            type="button"
            disabled={actionBusy}
            onClick={() => onToggleUnread(thread.id, thread.unreadCount > 0)}
            className="neu-btn inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium"
          >
            <MailOpen className="h-3.5 w-3.5" aria-hidden="true" />
            {thread.unreadCount > 0 ? "Mark Read" : "Mark Unread"}
          </button>
          {thread.folder !== "trash" ? (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => onMoveFolder(thread.id, "trash")}
              className="neu-btn-danger inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Trash
            </button>
          ) : (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => onDeletePermanent(thread.id)}
              className="neu-btn-danger-solid inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Delete Forever
            </button>
          )}
        </div>
      </header>

      {/* Scrollable Body */}
      <div className="postlet-scroll-region postlet-thread-scroll flex-1 space-y-4 overflow-y-auto">
        {/* Built-in Cloudflare Workers AI Summary Card */}
        <div className="neu-card rounded-2xl p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-[var(--neu-coral-text)]" aria-hidden="true" />
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--neu-text)]">
                Cloudflare AI Thread Brief
              </span>
              {thread.aiPriority && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                    thread.aiPriority === "high" ? "neu-badge-danger" : "neu-badge"
                  }`}
                >
                  {thread.aiPriority}
                </span>
              )}
              {thread.aiCategory && (
                <span className="neu-badge-coral rounded-full px-2 py-0.5 text-[10px] font-medium">
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
                  className="neu-btn-soft-coral inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
                >
                  <Bot className="h-3.5 w-3.5" aria-hidden="true" />
                  {aiBusy
                    ? "Thinking..."
                    : thread.aiSummary
                      ? "Refresh Summary"
                      : "Summarize & Triage"}
                </button>
                <button
                  type="button"
                  disabled={aiBusy}
                  onClick={() => onAutoReplyDraft(thread.id)}
                  className="neu-btn inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium"
                >
                  Draft AI Reply
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={onOpenAiSettings}
                className="text-xs font-semibold text-[var(--neu-coral-text)] hover:underline"
              >
                Enable Cloudflare AI in Settings →
              </button>
            )}
          </div>

          {thread.aiSummary ? (
            <p className="mt-2.5 whitespace-pre-line text-sm leading-relaxed text-[var(--neu-text-secondary)]">
              {thread.aiSummary}
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-[var(--neu-text-muted)]">
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
          const isTracked = msg.headers["x-postlet-track"] === "true";
          const normalizedSender = msg.fromAddress.trim().toLowerCase();
          const isSenderTrusted = settings.trustedImageSenders.includes(normalizedSender);
          const persistedAllowImages =
            msg.headers["x-postlet-allow-images"] === "true" || isSenderTrusted;

          return (
            <article
              key={msg.id}
              className={`neu-card postlet-message-card rounded-2xl ${
                isDraft ? "border-[var(--neu-coral-soft-border)]" : ""
              }`}
            >
              {isDraft && (
                <div className="neu-alert-coral mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl px-3.5 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="neu-badge-coral-solid rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                      Draft
                    </span>
                    <span className="text-xs font-medium text-[var(--neu-text)]">
                      Saved draft — ready to edit or send
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => onEditDraft(msg)}
                      className="neu-btn-accent inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold"
                    >
                      <Edit3 className="h-3.5 w-3.5" aria-hidden="true" />
                      Edit Draft
                    </button>
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => onSendDraft(msg)}
                      className="neu-btn-success inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold"
                    >
                      <Send className="h-3.5 w-3.5" aria-hidden="true" />
                      Send Now
                    </button>
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => onDiscardDraft(msg)}
                      className="neu-btn-danger inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Discard
                    </button>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--neu-divider)] pb-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-words text-sm font-semibold text-[var(--neu-text)]">
                      {msg.fromName ? `${msg.fromName} <${msg.fromAddress}>` : msg.fromAddress}
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium ${
                        msg.direction === "inbound" ? "neu-badge" : "neu-badge-coral"
                      }`}
                    >
                      {msg.direction === "inbound" ? "Inbound" : `Outbound · ${msg.status}`}
                    </span>
                    {msg.direction === "outbound" && isTracked && (
                      <span className="neu-badge-success inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium">
                        Tracked
                      </span>
                    )}
                    {msg.createdByActor !== "inbound" && msg.createdByActor !== "owner" && (
                      <span className="neu-badge-purple rounded-full px-2 py-0.5 font-mono text-[10px]">
                        {msg.createdByActor}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 break-words text-xs text-[var(--neu-text-muted)]">
                    To: {msg.toAddresses.join(", ")}
                    {msg.ccAddresses.length > 0 ? ` · Cc: ${msg.ccAddresses.join(", ")}` : ""}
                  </p>
                </div>

                <div className="text-right">
                  <time className="text-xs text-[var(--neu-text-muted)]">
                    {new Date(msg.createdAt).toLocaleString()}
                  </time>
                  {msg.deliveryError && (
                    <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
                      <p className="text-xs font-medium text-[var(--neu-danger-text)]">
                        {msg.deliveryError}
                      </p>
                      {canRetryFailed && (
                        <button
                          type="button"
                          disabled={actionBusy}
                          onClick={() => onEditDraft(msg)}
                          className="neu-btn-soft-coral inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
                        >
                          <Edit3 className="h-3 w-3" aria-hidden="true" />
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
                        className="neu-btn-soft-coral inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
                      >
                        <Edit3 className="h-3 w-3" aria-hidden="true" />
                        Edit &amp; Retry
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-3.5">
                <SanitizedEmailFrame
                  messageId={msg.id}
                  senderEmail={normalizedSender}
                  htmlBody={msg.htmlBody}
                  textBody={msg.textBody}
                  attachments={msg.attachments}
                  resolvedTheme={resolvedTheme}
                  persistedAllowImages={persistedAllowImages}
                  isSenderTrusted={isSenderTrusted}
                  onAllowImages={() => onAllowMessageImages(msg.id)}
                  onTrustSender={() => onTrustSenderImages(normalizedSender, msg.id)}
                />
              </div>

              {/* R2 Attachments */}
              {msg.attachments.length > 0 && (
                <div className="mt-4 border-t border-[var(--neu-divider)] pt-3">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[var(--neu-text-secondary)]">
                    <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
                    Attachments ({msg.attachments.length})
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {msg.attachments.map((att) => (
                      <a
                        key={att.id}
                        href={`/api/admin/attachments/${encodeURIComponent(att.id)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="neu-btn inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium"
                      >
                        <Paperclip
                          className="h-3 w-3 text-[var(--neu-coral-text)]"
                          aria-hidden="true"
                        />
                        <span className="max-w-[200px] truncate">{att.filename}</span>
                        <span className="text-[var(--neu-text-muted)]">
                          ({formatBytes(att.sizeBytes)})
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* Delivery timeline for outbound messages */}
              {msg.deliveryEvents.length > 0 && (
                <div className="mt-3.5 flex flex-wrap gap-2 border-t border-[var(--neu-divider)] pt-3 text-[11px]">
                  {msg.deliveryEvents.map((ev, idx) => {
                    const pillClass =
                      ev.type === "email.opened"
                        ? "neu-badge-success font-medium"
                        : ev.type === "email.clicked"
                          ? "neu-badge-coral font-medium"
                          : "neu-badge";
                    return (
                      <span
                        key={`${ev.type}-${idx}`}
                        className={`rounded-full px-2.5 py-0.5 ${pillClass}`}
                      >
                        {ev.type} · {new Date(ev.timestamp).toLocaleTimeString()}
                        {ev.detail ? ` (${ev.detail})` : ""}
                      </span>
                    );
                  })}
                </div>
              )}
            </article>
          );
        })}

        {/* Reply / Forward Bar */}
        {latestNonRejected && (
          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={() => onReply(latestNonRejected, false)}
              className="neu-btn-accent inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold"
            >
              <Reply className="h-3.5 w-3.5" aria-hidden="true" />
              Reply
            </button>
            <button
              type="button"
              onClick={() => onReply(latestNonRejected, true)}
              className="neu-btn inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-medium"
            >
              <ReplyAll className="h-3.5 w-3.5" aria-hidden="true" />
              Reply All
            </button>
            <button
              type="button"
              onClick={() => onForward(latestNonRejected)}
              className="neu-btn inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-medium"
            >
              <Forward className="h-3.5 w-3.5" aria-hidden="true" />
              Forward
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
