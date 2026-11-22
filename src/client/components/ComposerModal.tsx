/**
 * @file src/client/components/ComposerModal.tsx
 * @description Tactile Soft UI native modal `<dialog>` email composer supporting new compose,
 * Reply, Reply All, Forward, editing saved drafts, editing Pending Approval drafts,
 * Rich Text / Markdown / Plain Text modes, Resend open & link tracking toggle, R2 attachments,
 * and Cloudflare Workers AI reply assistance.
 */

import { Paperclip, Send, Sparkles, Trash2, X } from "lucide-react";
import { marked } from "marked";
import { useEffect, useId, useRef, useState } from "react";
import type { AddressRecord, AppSettings, AttachmentRecord } from "../../shared/types";
import { api } from "../lib/api";
import { buildEmailIframeSrcDoc, plainTextToBasicHtml, sanitizeEmailHtml } from "../lib/sanitize";
import type { ResolvedTheme } from "../lib/theme";
import { RichTextEditor } from "./RichTextEditor";

export interface ComposerInitialState {
  mode: "new" | "reply" | "forward" | "approve_edit" | "edit_draft";
  draftMessageId?: string;
  pendingMessageId?: string;
  threadId?: string;
  replyToMessageId?: string;
  forwardMessageId?: string;
  fromAddress?: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  htmlBody?: string;
  attachments?: AttachmentRecord[];
  initialFormat?: "rich" | "markdown" | "plain";
  trackOpensAndClicks?: boolean;
}

interface ComposerModalProps {
  isOpen: boolean;
  initial: ComposerInitialState | null;
  addresses: AddressRecord[];
  settings: AppSettings;
  resolvedTheme: ResolvedTheme;
  onClose: () => void;
  onDiscardDraft?: (messageId: string, threadId?: string) => Promise<void> | void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}

interface ComposerSnapshot {
  fromAddress: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  richHtml: string;
  attachmentIdsKey: string;
  trackOpensAndClicks: boolean;
}

export function ComposerModal({
  isOpen,
  initial,
  addresses,
  settings,
  resolvedTheme,
  onClose,
  onDiscardDraft,
  onSuccess,
  onError,
}: ComposerModalProps) {
  const titleId = useId();
  const confirmDescId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keepEditingButtonRef = useRef<HTMLButtonElement>(null);

  const [fromAddress, setFromAddress] = useState("");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [richHtml, setRichHtml] = useState("");
  const [richSyncKey, setRichSyncKey] = useState(0);
  const [format, setFormat] = useState<"rich" | "markdown" | "plain">("rich");
  const [previewHtml, setPreviewHtml] = useState(false);
  const [previewSrcDoc, setPreviewSrcDoc] = useState("");
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([]);
  const [trackOpensAndClicks, setTrackOpensAndClicks] = useState(false);
  const [initialSnapshot, setInitialSnapshot] = useState<ComposerSnapshot>({
    fromAddress: "",
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    body: "",
    richHtml: "",
    attachmentIdsKey: "",
    trackOpensAndClicks: false,
  });
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const currentAttachmentKey = attachments.map((a) => a.id).join(",");
  const isDirty =
    fromAddress !== initialSnapshot.fromAddress ||
    to !== initialSnapshot.to ||
    cc !== initialSnapshot.cc ||
    bcc !== initialSnapshot.bcc ||
    subject !== initialSnapshot.subject ||
    body !== initialSnapshot.body ||
    (format === "rich" && richHtml !== initialSnapshot.richHtml) ||
    currentAttachmentKey !== initialSnapshot.attachmentIdsKey ||
    trackOpensAndClicks !== initialSnapshot.trackOpensAndClicks;

  useEffect(() => {
    if (isOpen && initial) {
      const defaultAddr = addresses.find((a) => a.isDefault)?.email ?? addresses[0]?.email ?? "";
      const resolvedFrom = initial.fromAddress || defaultAddr;
      const initialAttachments = initial.attachments ?? [];
      const nextFormat = initial.initialFormat ?? "rich";
      const nextHtml = initial.htmlBody?.trim()
        ? initial.htmlBody
        : plainTextToBasicHtml(initial.body);
      const nextTrack = Boolean(initial.trackOpensAndClicks);

      setFromAddress(resolvedFrom);
      setTo(initial.to);
      setCc(initial.cc);
      setBcc(initial.bcc);
      setShowCcBcc(Boolean(initial.cc || initial.bcc));
      setSubject(initial.subject);
      setBody(initial.body);
      setRichHtml(nextHtml);
      setRichSyncKey((k) => k + 1);
      setFormat(nextFormat);
      setAttachments(initialAttachments);
      setTrackOpensAndClicks(nextTrack);
      setInitialSnapshot({
        fromAddress: resolvedFrom,
        to: initial.to,
        cc: initial.cc,
        bcc: initial.bcc,
        subject: initial.subject,
        body: initial.body,
        richHtml: nextHtml,
        attachmentIdsKey: initialAttachments.map((a) => a.id).join(","),
        trackOpensAndClicks: nextTrack,
      });
      setPreviewHtml(false);
      setShowDiscardConfirm(false);
    }
  }, [isOpen, initial, addresses]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen && !dialog.open) {
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.returnValue = "";
      dialog.close();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!previewHtml) {
      setPreviewSrcDoc("");
      return;
    }
    let cancelled = false;
    void (async () => {
      const rawHtml = await marked.parse(body, { async: true });
      const sanitized = await sanitizeEmailHtml(rawHtml);
      if (!cancelled) {
        setPreviewSrcDoc(buildEmailIframeSrcDoc(sanitized, { theme: resolvedTheme }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewHtml, body, resolvedTheme]);

  function parseAddressList(raw: string): string[] {
    return raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  function requestClose() {
    if (isDirty && !sending) {
      setShowDiscardConfirm(true);
      queueMicrotask(() => keepEditingButtonRef.current?.focus());
      return;
    }
    onClose();
  }

  async function handleFileUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const uploaded: AttachmentRecord[] = [];
      for (const file of Array.from(files)) {
        const res = await api.uploadAttachment(file);
        uploaded.push(res.attachment);
      }
      setAttachments((prev) => [...prev, ...uploaded]);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to upload attachment");
    } finally {
      setUploading(false);
    }
  }

  async function handleFormatChange(nextFormat: "rich" | "markdown" | "plain") {
    if (nextFormat === "rich" && format !== "rich") {
      const nextHtml =
        format === "markdown"
          ? await sanitizeEmailHtml(await marked.parse(body, { async: true }))
          : plainTextToBasicHtml(body);
      setRichHtml(nextHtml);
      setRichSyncKey((k) => k + 1);
    }
    setFormat(nextFormat);
    setPreviewHtml(false);
  }

  async function handleAiDraftReply() {
    if (!initial?.threadId) return;
    setAiBusy(true);
    try {
      const res = await api.suggestReply(initial.threadId, body.trim());
      setBody(res.replyText);
      if (format === "rich") {
        setRichHtml(plainTextToBasicHtml(res.replyText));
        setRichSyncKey((k) => k + 1);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "AI draft generation failed");
    } finally {
      setAiBusy(false);
    }
  }

  async function handleSubmit(mode: "send" | "draft") {
    const toList = parseAddressList(to);
    if (toList.length === 0) {
      onError("Enter at least one recipient email in To.");
      return;
    }
    if (!subject.trim()) {
      onError("Subject is required.");
      return;
    }

    setSending(true);
    try {
      const renderedHtml =
        format === "rich"
          ? await sanitizeEmailHtml(richHtml)
          : format === "markdown"
            ? await sanitizeEmailHtml(await marked.parse(body, { async: true }))
            : "";

      if (initial?.mode === "approve_edit" && initial.pendingMessageId && mode === "send") {
        await api.approveMessage(initial.pendingMessageId, {
          to: toList,
          cc: parseAddressList(cc),
          bcc: parseAddressList(bcc),
          subject: subject.trim(),
          textBody: body,
          htmlBody: renderedHtml,
        });
        onSuccess("Draft approved and sent via Resend.");
      } else if (initial?.mode === "edit_draft" && initial.draftMessageId) {
        await api.updateDraftMessage(initial.draftMessageId, {
          mode,
          fromAddress: fromAddress || undefined,
          to: toList,
          cc: parseAddressList(cc),
          bcc: parseAddressList(bcc),
          subject: subject.trim(),
          textBody: body,
          htmlBody: renderedHtml,
          attachmentIds: attachments.map((a) => a.id),
          trackOpensAndClicks,
        });
        onSuccess(mode === "send" ? "Email sent via Resend." : "Draft updated.");
      } else {
        await api.sendOrDraftMessage({
          mode,
          fromAddress: fromAddress || undefined,
          to: toList,
          cc: parseAddressList(cc),
          bcc: parseAddressList(bcc),
          subject: subject.trim(),
          textBody: body,
          htmlBody: renderedHtml,
          threadId: initial?.threadId,
          replyToMessageId: initial?.replyToMessageId,
          forwardMessageId: initial?.forwardMessageId,
          attachmentIds: attachments.map((a) => a.id),
          trackOpensAndClicks,
        });
        onSuccess(mode === "send" ? "Email sent via Resend." : "Draft saved.");
      }
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to send email");
    } finally {
      setSending(false);
    }
  }

  const activeAddresses = addresses.filter((a) => a.isActive);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      {...({ closedby: isDirty ? "none" : "closerequest" } as Record<string, string>)}
      onCancel={(e) => {
        if (isDirty) {
          e.preventDefault();
          setShowDiscardConfirm(true);
          queueMicrotask(() => keepEditingButtonRef.current?.focus());
        } else {
          onClose();
        }
      }}
      onClose={() => {
        if (dialogRef.current) {
          dialogRef.current.returnValue = "";
        }
        if (isOpen) {
          onClose();
        }
      }}
      className="neu-card-lg m-auto w-[min(94vw,760px)] rounded-3xl p-0"
    >
      <div className="flex flex-col">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-[var(--neu-divider)] px-5 py-3.5">
          <h2 id={titleId} className="text-base font-semibold text-[var(--neu-text)]">
            {initial?.mode === "approve_edit"
              ? "Edit & Approve Draft"
              : initial?.mode === "edit_draft"
                ? "Edit Draft"
                : initial?.mode === "reply"
                  ? "Reply"
                  : initial?.mode === "forward"
                    ? "Forward Message"
                    : "New Message"}
          </h2>
          <button
            type="button"
            onClick={requestClose}
            className="neu-icon-btn h-8 w-8"
            aria-label="Close composer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Reserved space for unsaved-changes confirmation (hidden with visibility so buttons never jump) */}
        <div
          aria-hidden={!showDiscardConfirm}
          className={`flex items-center justify-between border-b border-[var(--neu-warning-border)] bg-[var(--neu-warning-bg)] px-5 py-2 text-xs text-[var(--neu-warning-text)] ${
            showDiscardConfirm ? "visible" : "invisible pointer-events-none"
          }`}
        >
          <span id={confirmDescId} className="font-medium">
            Discard unsaved email changes?
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              tabIndex={showDiscardConfirm ? 0 : -1}
              onClick={() => {
                setShowDiscardConfirm(false);
                onClose();
              }}
              className="neu-btn-danger-solid rounded-full px-3 py-1 text-xs font-semibold"
            >
              Discard
            </button>
            <button
              ref={keepEditingButtonRef}
              type="button"
              tabIndex={showDiscardConfirm ? 0 : -1}
              aria-describedby={confirmDescId}
              onClick={() => setShowDiscardConfirm(false)}
              className="neu-btn rounded-full px-3 py-1 text-xs font-medium"
            >
              Keep Editing
            </button>
          </div>
        </div>

        {/* Form Fields */}
        <div className="space-y-3 p-5">
          <div className="grid grid-cols-[72px_1fr] items-center gap-2">
            <label
              htmlFor="compose-from"
              className="text-xs font-medium text-[var(--neu-text-secondary)]"
            >
              From
            </label>
            {activeAddresses.length > 0 ? (
              <select
                id="compose-from"
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value)}
                className="neu-input rounded-xl px-3 py-1.5 text-sm"
              >
                {activeAddresses.map((a) => (
                  <option key={a.id} value={a.email}>
                    {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
                  </option>
                ))}
                {fromAddress && !activeAddresses.some((a) => a.email === fromAddress) && (
                  <option value={fromAddress}>{fromAddress}</option>
                )}
              </select>
            ) : (
              <input
                id="compose-from"
                type="email"
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value)}
                placeholder="you@yourdomain.com (configure in Settings -> Addresses)"
                className="neu-input rounded-xl px-3 py-1.5 text-sm"
              />
            )}
          </div>

          <div className="grid grid-cols-[72px_1fr_auto] items-center gap-2">
            <label
              htmlFor="compose-to"
              className="text-xs font-medium text-[var(--neu-text-secondary)]"
            >
              To
            </label>
            <input
              id="compose-to"
              type="text"
              autoFocus={initial?.mode !== "reply"}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@example.com (comma separated)"
              className="neu-input rounded-xl px-3 py-1.5 text-sm"
            />
            <button
              type="button"
              onClick={() => setShowCcBcc((v) => !v)}
              className="neu-btn rounded-full px-3 py-1.5 text-xs font-medium text-[var(--neu-text-secondary)]"
            >
              Cc / Bcc
            </button>
          </div>

          {showCcBcc && (
            <>
              <div className="grid grid-cols-[72px_1fr] items-center gap-2">
                <label
                  htmlFor="compose-cc"
                  className="text-xs font-medium text-[var(--neu-text-secondary)]"
                >
                  Cc
                </label>
                <input
                  id="compose-cc"
                  type="text"
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                  placeholder="cc@example.com"
                  className="neu-input rounded-xl px-3 py-1.5 text-sm"
                />
              </div>
              <div className="grid grid-cols-[72px_1fr] items-center gap-2">
                <label
                  htmlFor="compose-bcc"
                  className="text-xs font-medium text-[var(--neu-text-secondary)]"
                >
                  Bcc
                </label>
                <input
                  id="compose-bcc"
                  type="text"
                  value={bcc}
                  onChange={(e) => setBcc(e.target.value)}
                  placeholder="bcc@example.com"
                  className="neu-input rounded-xl px-3 py-1.5 text-sm"
                />
              </div>
            </>
          )}

          <div className="grid grid-cols-[72px_1fr] items-center gap-2">
            <label
              htmlFor="compose-subject"
              className="text-xs font-medium text-[var(--neu-text-secondary)]"
            >
              Subject
            </label>
            <input
              id="compose-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Email subject"
              className="neu-input rounded-xl px-3 py-1.5 text-sm"
            />
          </div>

          {/* Editor Mode Segmented Pill Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="neu-segmented text-xs">
              <button
                type="button"
                data-active={format === "rich"}
                onClick={() => void handleFormatChange("rich")}
                className="neu-segmented-btn px-3 py-1 font-medium"
              >
                Rich Text
              </button>
              <button
                type="button"
                data-active={format === "markdown" && !previewHtml}
                onClick={() => void handleFormatChange("markdown")}
                className="neu-segmented-btn px-3 py-1 font-medium"
              >
                Markdown
              </button>
              <button
                type="button"
                data-active={format === "plain"}
                onClick={() => void handleFormatChange("plain")}
                className="neu-segmented-btn px-3 py-1 font-medium"
              >
                Plain Text
              </button>
              {format === "markdown" && (
                <button
                  type="button"
                  data-active={previewHtml}
                  onClick={() => setPreviewHtml((p) => !p)}
                  className="neu-segmented-btn px-3 py-1 font-medium"
                >
                  Preview HTML
                </button>
              )}
            </div>

            {settings.aiEnabled && initial?.threadId && (
              <button
                type="button"
                disabled={aiBusy}
                onClick={handleAiDraftReply}
                className="neu-btn-soft-coral inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                {aiBusy ? "Drafting..." : "AI Draft Reply"}
              </button>
            )}
          </div>

          {format === "rich" ? (
            <RichTextEditor
              initialHtml={richHtml}
              syncKey={richSyncKey}
              autoFocus={initial?.mode === "reply"}
              placeholder="Write your rich-text message..."
              onChange={({ html, text }) => {
                setRichHtml(html);
                setBody(text);
              }}
            />
          ) : previewHtml ? (
            <iframe
              title="Email Markdown preview"
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              srcDoc={previewSrcDoc}
              className="h-[240px] w-full rounded-2xl border border-[var(--neu-border)] bg-[var(--neu-inset)]"
            />
          ) : (
            <textarea
              autoFocus={initial?.mode === "reply"}
              rows={9}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={
                format === "markdown"
                  ? "Write your message (Markdown supported)..."
                  : "Write your plain text message..."
              }
              className="neu-input w-full rounded-2xl p-3 text-sm leading-relaxed"
            />
          )}

          {/* Resend Open & Click Tracking Switch */}
          {initial?.mode !== "approve_edit" && (
            <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-3 text-xs text-[var(--neu-text-secondary)] select-none">
              <input
                type="checkbox"
                role="switch"
                {...({ switch: "" } as Record<string, string>)}
                checked={trackOpensAndClicks}
                onChange={(e) => setTrackOpensAndClicks(e.target.checked)}
                className="neu-switch"
              />
              <span>
                <span className="font-medium text-[var(--neu-text)]">
                  Enable Resend open &amp; link tracking
                </span>{" "}
                <span className="text-[11px] text-[var(--neu-text-muted)]">
                  (adds a hidden tracking link)
                </span>
              </span>
            </label>
          )}

          {/* Attachments List */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((att) => (
                <span
                  key={att.id}
                  className="neu-inset inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs text-[var(--neu-text)]"
                >
                  <Paperclip className="h-3 w-3 text-[var(--neu-coral-text)]" aria-hidden="true" />
                  <span>{att.filename}</span>
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                    className="rounded-full p-0.5 text-[var(--neu-text-muted)] hover:text-[var(--neu-danger-text)]"
                    aria-label={`Remove ${att.filename}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="neu-panel flex flex-wrap items-center justify-between gap-2 rounded-b-3xl border-t border-[var(--neu-divider)] px-5 py-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <label className="neu-btn inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium">
              <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{uploading ? "Uploading..." : "Attach File"}</span>
              <input
                type="file"
                multiple
                disabled={uploading}
                onChange={(e) => void handleFileUpload(e.target.files)}
                className="sr-only"
              />
            </label>
            {initial?.mode === "edit_draft" && initial.draftMessageId && onDiscardDraft && (
              <button
                type="button"
                disabled={sending || uploading}
                onClick={async () => {
                  const id = initial.draftMessageId;
                  if (!id) return;
                  setSending(true);
                  try {
                    await onDiscardDraft(id, initial.threadId);
                  } finally {
                    setSending(false);
                  }
                }}
                className="neu-btn-danger inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Discard Draft
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {initial?.mode !== "approve_edit" && (
              <button
                type="button"
                disabled={sending}
                onClick={() => void handleSubmit("draft")}
                className="neu-btn rounded-full px-4 py-2 text-xs font-medium"
              >
                Save Draft
              </button>
            )}
            <button
              type="button"
              disabled={sending || uploading}
              onClick={() => void handleSubmit("send")}
              className="neu-btn-accent inline-flex items-center gap-1.5 rounded-full px-5 py-2 text-xs font-semibold"
            >
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              {sending
                ? "Sending..."
                : initial?.mode === "approve_edit"
                  ? "Approve & Send"
                  : "Send Email"}
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
