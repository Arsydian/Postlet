/**
 * @file src/client/components/ApprovalBanner.tsx
 * @description Tactile actionable review banner displayed on messages queued in `pending_approval`
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
    <div className="neu-alert-warning rounded-2xl p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold">
              Pending Approval — Drafted by{" "}
              <span className="font-mono text-xs">{message.createdByActor}</span>
            </p>
            <p className="mt-0.5 text-xs opacity-90">
              To: {message.toAddresses.join(", ")} · From: {message.fromAddress}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onApprove(message.id)}
            className="neu-btn-success inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold"
          >
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            Approve &amp; Send
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onEdit(message)}
            className="neu-btn inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium"
          >
            <Edit3 className="h-3.5 w-3.5" aria-hidden="true" />
            Edit Draft
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onReject(message.id)}
            className="neu-btn-danger inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium"
          >
            <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
            Reject
          </button>
        </div>
      </div>

      <div className="neu-inset mt-3 rounded-xl p-3 text-sm text-[var(--neu-text)] whitespace-pre-wrap">
        {message.textBody || "(No plain text body)"}
      </div>
    </div>
  );
}
