/**
 * @file src/client/components/ApprovalBanner.tsx
 * @description Actionable review banner displayed on messages queued in `pending_approval`
 * by external AI agents (`read_draft`) or built-in Important Email Auto-Reply.
 */

import { CheckCircle2, Edit3, ShieldAlert, XCircle } from "lucide-react";
import type { MessageRecord } from "../../shared/types";

interface ApprovalBannerProps {
  message: MessageRecord;
  busy: boolean;
  onApprove: (messageId: string) => void;
  onEdit: (message: MessageRecord) => void;
  onReject: (messageId: string) => void;
}

export function ApprovalBanner({
  message,
  busy,
  onApprove,
  onEdit,
  onReject,
}: ApprovalBannerProps) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50/90 p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <p className="text-sm font-semibold text-amber-950">
              Pending Approval — Drafted by{" "}
              <span className="font-mono text-xs">{message.createdByActor}</span>
            </p>
            <p className="mt-0.5 text-xs text-amber-800">
              To: {message.toAddresses.join(", ")} · From: {message.fromAddress}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onApprove(message.id)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Approve &amp; Send
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onEdit(message)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 transition hover:bg-amber-100 disabled:opacity-50"
          >
            <Edit3 className="h-3.5 w-3.5" />
            Edit Draft
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onReject(message.id)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
          >
            <XCircle className="h-3.5 w-3.5" />
            Reject
          </button>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-amber-200 bg-white p-3 text-sm text-slate-800 whitespace-pre-wrap">
        {message.textBody || "(No plain text body)"}
      </div>
    </div>
  );
}
