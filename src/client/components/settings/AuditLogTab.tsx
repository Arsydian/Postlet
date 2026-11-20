/**
 * @file src/client/components/settings/AuditLogTab.tsx
 * @description Filterable audit trail inspecting external AI agent calls, built-in
 * Cloudflare AI invocations (`postlet_ai`), and owner draft approvals/rejections.
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
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">AI &amp; Agent Audit Log</h2>
          <p className="text-xs text-slate-500">
            Tracks reads, drafts, sends, denied permissions, and built-in Cloudflare AI calls.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Filter by actor type"
            value={actorType}
            onChange={(e) => setActorType(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
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
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
          >
            <option value="">All Statuses</option>
            <option value="allowed">Allowed</option>
            <option value="denied">Denied</option>
            <option value="error">Error</option>
          </select>

          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50"
            aria-label="Refresh audit log"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-3.5 py-2.5 font-medium">Time</th>
              <th className="px-3.5 py-2.5 font-medium">Actor</th>
              <th className="px-3.5 py-2.5 font-medium">Action</th>
              <th className="px-3.5 py-2.5 font-medium">Status</th>
              <th className="px-3.5 py-2.5 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {logs.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  {loading ? "Loading audit logs..." : "No audit entries matching current filters."}
                </td>
              </tr>
            ) : (
              logs.map((entry) => (
                <tr key={entry.id} className="hover:bg-slate-50/70">
                  <td className="whitespace-nowrap px-3.5 py-2.5 text-slate-500">
                    {new Date(entry.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3.5 py-2.5">
                    <span className="font-medium text-slate-800">{entry.actorLabel}</span>
                    <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                      {entry.actorType}
                    </span>
                  </td>
                  <td className="px-3.5 py-2.5 font-mono text-[11px] text-slate-700">
                    {entry.action}
                  </td>
                  <td className="px-3.5 py-2.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        entry.status === "allowed"
                          ? "bg-emerald-50 text-emerald-700"
                          : entry.status === "denied"
                            ? "bg-amber-50 text-amber-800"
                            : "bg-rose-50 text-rose-700"
                      }`}
                    >
                      {entry.status}
                    </span>
                  </td>
                  <td className="max-w-xs truncate px-3.5 py-2.5 font-mono text-[11px] text-slate-500">
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
