/**
 * @file src/client/components/ComposerModal.tsx
 * @description Native modal <dialog> email composer supporting new compose, Reply, Reply All,
 * Forward, editing saved drafts, editing Pending Approval drafts, Markdown/HTML rendering,
 * R2 attachment uploads, and Cloudflare Workers AI reply assistance.
 */

import { Paperclip, Send, Sparkles, Trash2, X } from "lucide-react";
import { marked } from "marked";
import { useEffect, useId, useRef, useState } from "react";
import type { AddressRecord, AppSettings, AttachmentRecord } from "../../shared/types";
import { api } from "../lib/api";
import { buildEmailIframeSrcDoc, sanitizeEmailHtml } from "../lib/sanitize";

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
  attachments?: AttachmentRecord[];
  initialFormat?: "markdown" | "plain";
}

interface ComposerModalProps {
  isOpen: boolean;
  initial: ComposerInitialState | null;
  addresses: AddressRecord[];
  settings: AppSettings;
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
  attachmentIdsKey: string;
}

export function ComposerModal({
  isOpen,
  initial,
  addresses,
  settings,
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
  const [format, setFormat] = useState<"markdown" | "plain">("markdown");
  const [previewHtml, setPreviewHtml] = useState(false);
  const [previewSrcDoc, setPreviewSrcDoc] = useState("");
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([]);
  const [initialSnapshot, setInitialSnapshot] = useState<ComposerSnapshot>({
    fromAddress: "",
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    body: "",
    attachmentIdsKey: "",
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
    currentAttachmentKey !== initialSnapshot.attachmentIdsKey;

  useEffect(() => {
    if (isOpen && initial) {
      const defaultAddr = addresses.find((a) => a.isDefault)?.email ?? addresses[0]?.email ?? "";
      const resolvedFrom = initial.fromAddress || defaultAddr;
      const initialAttachments = initial.attachments ?? [];
      setFromAddress(resolvedFrom);
      setTo(initial.to);
      setCc(initial.cc);
      setBcc(initial.bcc);
      setShowCcBcc(Boolean(initial.cc || initial.bcc));
      setSubject(initial.subject);
      setBody(initial.body);
      setFormat(initial.initialFormat ?? "markdown");
      setAttachments(initialAttachments);
      setInitialSnapshot({
        fromAddress: resolvedFrom,
        to: initial.to,
        cc: initial.cc,
        bcc: initial.bcc,
        subject: initial.subject,
        body: initial.body,
        attachmentIdsKey: initialAttachments.map((a) => a.id).join(","),
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
        setPreviewSrcDoc(buildEmailIframeSrcDoc(sanitized));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewHtml, body]);

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

  async function handleAiDraftReply() {
    if (!initial?.threadId) return;
    setAiBusy(true);
    try {
      const res = await api.suggestReply(initial.threadId, body.trim());
      setBody(res.replyText);
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
        format === "markdown"
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
      className="m-auto w-[min(94vw,760px)] rounded-2xl border border-slate-200 bg-white p-0 shadow-2xl"
    >
      <div className="flex flex-col">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
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
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close composer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Reserved space for unsaved-changes confirmation (hidden with visibility so buttons never jump) */}
        <div
          aria-hidden={!showDiscardConfirm}
          className={`flex items-center justify-between border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-900 ${
            showDiscardConfirm ? "visible" : "invisible pointer-events-none"
          }`}
        >
          <span id={confirmDescId}>Discard unsaved email changes?</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              tabIndex={showDiscardConfirm ? 0 : -1}
              onClick={() => {
                setShowDiscardConfirm(false);
                onClose();
              }}
              className="rounded-md bg-rose-600 px-2.5 py-1 font-semibold text-white hover:bg-rose-700"
            >
              Discard
            </button>
            <button
              ref={keepEditingButtonRef}
              type="button"
              tabIndex={showDiscardConfirm ? 0 : -1}
              aria-describedby={confirmDescId}
              onClick={() => setShowDiscardConfirm(false)}
              className="rounded-md border border-amber-300 bg-white px-2.5 py-1 font-medium text-amber-900 hover:bg-amber-100"
            >
              Keep Editing
            </button>
          </div>
        </div>

        {/* Form Fields */}
        <div className="space-y-3 p-5">
          <div className="grid grid-cols-[72px_1fr] items-center gap-2">
            <label htmlFor="compose-from" className="text-xs font-medium text-slate-500">
              From
            </label>
            {activeAddresses.length > 0 ? (
              <select
                id="compose-from"
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
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
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
              />
            )}
          </div>

          <div className="grid grid-cols-[72px_1fr_auto] items-center gap-2">
            <label htmlFor="compose-to" className="text-xs font-medium text-slate-500">
              To
            </label>
            <input
              id="compose-to"
              type="text"
              autoFocus={initial?.mode !== "reply"}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@example.com (comma separated)"
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShowCcBcc((v) => !v)}
              className="text-xs font-medium text-slate-500 hover:text-indigo-600"
            >
              Cc / Bcc
            </button>
          </div>

          {showCcBcc && (
            <>
              <div className="grid grid-cols-[72px_1fr] items-center gap-2">
                <label htmlFor="compose-cc" className="text-xs font-medium text-slate-500">
                  Cc
                </label>
                <input
                  id="compose-cc"
                  type="text"
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                  placeholder="cc@example.com"
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-[72px_1fr] items-center gap-2">
                <label htmlFor="compose-bcc" className="text-xs font-medium text-slate-500">
                  Bcc
                </label>
                <input
                  id="compose-bcc"
                  type="text"
                  value={bcc}
                  onChange={(e) => setBcc(e.target.value)}
                  placeholder="bcc@example.com"
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </>
          )}

          <div className="grid grid-cols-[72px_1fr] items-center gap-2">
            <label htmlFor="compose-subject" className="text-xs font-medium text-slate-500">
              Subject
            </label>
            <input
              id="compose-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Email subject"
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>

          {/* Editor Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => {
                  setFormat("markdown");
                  setPreviewHtml(false);
                }}
                className={`rounded-md px-2.5 py-1 font-medium ${
                  format === "markdown" && !previewHtml
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600"
                }`}
              >
                Markdown
              </button>
              <button
                type="button"
                onClick={() => {
                  setFormat("plain");
                  setPreviewHtml(false);
                }}
                className={`rounded-md px-2.5 py-1 font-medium ${
                  format === "plain" && !previewHtml
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600"
                }`}
              >
                Plain Text
              </button>
              {format === "markdown" && (
                <button
                  type="button"
                  onClick={() => setPreviewHtml((p) => !p)}
                  className={`rounded-md px-2.5 py-1 font-medium ${
                    previewHtml ? "bg-indigo-600 text-white" : "text-slate-600"
                  }`}
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
                className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {aiBusy ? "Drafting..." : "AI Draft Reply"}
              </button>
            )}
          </div>

          {previewHtml ? (
            <iframe
              title="Email Markdown preview"
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              srcDoc={previewSrcDoc}
              className="h-[240px] w-full rounded-xl border border-slate-200 bg-white"
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
              className="w-full rounded-xl border border-slate-200 p-3 text-sm leading-relaxed text-slate-900 focus:border-indigo-500 focus:outline-none"
            />
          )}

          {/* Attachments List */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((att) => (
                <span
                  key={att.id}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700"
                >
                  <Paperclip className="h-3 w-3 text-slate-400" />
                  <span>{att.filename}</span>
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                    className="text-slate-400 hover:text-rose-600"
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
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3.5 rounded-b-2xl">
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
              <Paperclip className="h-3.5 w-3.5" />
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
                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
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
                className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                Save Draft
              </button>
            )}
            <button
              type="button"
              disabled={sending || uploading}
              onClick={() => void handleSubmit("send")}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
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
