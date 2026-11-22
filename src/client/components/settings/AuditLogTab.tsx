/**
 * @file src/client/components/settings/AuditLogTab.tsx
 * @description Tactile Soft UI filterable audit trail inspecting external AI agent calls,
 * built-in Cloudflare AI invocations (`postlet_ai`), and owner draft approvals/rejections.
 */

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { AuditLogRecord } from "../../../shared/types";
import { api } from "../../lib/api";

interface AuditLogTabProps {
  onError: (msg: string) => void;
}

export function AuditLogTab({ onError }: AuditLogTabProps) {
  const [logs, setLogs] = useState<AuditLogRecord[]>([]);
  const [actorType, setActorType] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await api.listAuditLogs({
        actorType: actorType || undefined,
        status: status || undefined,
      });
      setLogs(res.logs);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load audit log");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [actorType, status]);

  return (
    <div className="neu-card rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--neu-text)]">
            AI &amp; Agent Audit Log
          </h2>
          <p className="text-xs text-[var(--neu-text-muted)]">
            Tracks reads, drafts, sends, denied permissions, and built-in Cloudflare AI calls.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Filter by actor type"
            value={actorType}
            onChange={(e) => setActorType(e.target.value)}
            className="neu-input rounded-full px-3.5 py-1.5 text-xs"
          >
            <option value="">All Actors</option>
            <option value="agent_key">External Agent Keys</option>
            <option value="postlet_ai">Built-In Cloudflare AI</option>
            <option value="owner">Owner Actions</option>
          </select>

          <select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="neu-input rounded-full px-3.5 py-1.5 text-xs"
          >
            <option value="">All Statuses</option>
            <option value="allowed">Allowed</option>
            <option value="denied">Denied</option>
            <option value="error">Error</option>
          </select>

          <button
            type="button"
            onClick={() => void load()}
            className="neu-icon-btn h-8 w-8"
            aria-label="Refresh audit log"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div className="neu-inset mt-4 overflow-x-auto rounded-2xl">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="border-b border-[var(--neu-divider)] text-[var(--neu-text-muted)]">
            <tr>
              <th className="px-3.5 py-2.5 font-semibold">Time</th>
              <th className="px-3.5 py-2.5 font-semibold">Actor</th>
              <th className="px-3.5 py-2.5 font-semibold">Action</th>
              <th className="px-3.5 py-2.5 font-semibold">Status</th>
              <th className="px-3.5 py-2.5 font-semibold">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--neu-divider)]">
            {logs.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-[var(--neu-text-muted)]">
                  {loading ? "Loading audit logs..." : "No audit entries matching current filters."}
                </td>
              </tr>
            ) : (
              logs.map((entry) => (
                <tr
                  key={entry.id}
                  className="transition-colors hover:bg-[var(--neu-surface-raised)]"
                >
                  <td className="whitespace-nowrap px-3.5 py-2.5 text-[var(--neu-text-muted)]">
                    {new Date(entry.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3.5 py-2.5">
                    <span className="font-medium text-[var(--neu-text)]">{entry.actorLabel}</span>
                    <span className="neu-badge ml-1.5 rounded-full px-2 py-0.5 text-[10px]">
                      {entry.actorType}
                    </span>
                  </td>
                  <td className="px-3.5 py-2.5 font-mono text-[11px] text-[var(--neu-text-secondary)]">
                    {entry.action}
                  </td>
                  <td className="px-3.5 py-2.5">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${
                        entry.status === "allowed"
                          ? "neu-badge-success"
                          : entry.status === "denied"
                            ? "neu-badge-warning"
                            : "neu-badge-danger"
                      }`}
                    >
                      {entry.status}
                    </span>
                  </td>
                  <td className="max-w-xs truncate px-3.5 py-2.5 font-mono text-[11px] text-[var(--neu-text-muted)]">
                    {JSON.stringify(entry.details)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
