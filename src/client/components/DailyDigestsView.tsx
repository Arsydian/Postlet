/**
 * @file src/client/components/DailyDigestsView.tsx
 * @description View displaying generated Daily Inbox Summaries (overview, interactive To-Dos,
 * reminders/deadlines, and FYI rollups) with click-through thread navigation.
 */

import { Bell, CalendarClock, CheckSquare, ExternalLink, Menu, Sparkles, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppSettings, DailyDigest } from "../../shared/types";
import { api } from "../lib/api";

interface DailyDigestsViewProps {
  settings: AppSettings;
  onOpenThread: (threadId: string) => void;
  onOpenAiSettings: () => void;
  onOpenMobileNav: () => void;
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
}

export function DailyDigestsView({
  settings,
  onOpenThread,
  onOpenAiSettings,
  onOpenMobileNav,
  onError,
  onSuccess,
}: DailyDigestsViewProps) {
  const [digests, setDigests] = useState<DailyDigest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  async function loadDigests() {
    setLoading(true);
    try {
      const res = await api.listDigests();
      setDigests(res.digests);
      if (res.digests.length > 0 && !selectedId) {
        setSelectedId(res.digests[0].id);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load daily digests");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDigests();
  }, []);

  async function handleGenerateNow() {
    setGenerating(true);
    try {
      const res = await api.generateDigest(settings.aiDailySummaryEmailCopy);
      setDigests((prev) => [res.digest, ...prev]);
      setSelectedId(res.digest.id);
      onSuccess("Daily Inbox Summary generated.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to generate summary");
    } finally {
      setGenerating(false);
    }
  }

  async function handleToggleTodo(digestId: string, todoId: string, done: boolean) {
    try {
      const res = await api.toggleDigestTodo(digestId, todoId, done);
      setDigests((prev) => prev.map((d) => (d.id === digestId ? res.digest : d)));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to update To-Do");
    }
  }

  const active = digests.find((d) => d.id === selectedId) ?? digests[0] ?? null;

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-slate-50">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onOpenMobileNav}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </button>
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
              <Sparkles className="h-5 w-5 text-indigo-600" />
              Daily Inbox Summaries
            </h1>
            <p className="text-xs text-slate-500">
              Actionable To-Dos, reminders, and executive rollups built by Cloudflare Workers AI.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!settings.aiEnabled ? (
            <button
              type="button"
              onClick={onOpenAiSettings}
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 hover:bg-amber-100"
            >
              Enable Cloudflare AI in Settings →
            </button>
          ) : (
            <button
              type="button"
              disabled={generating}
              onClick={() => void handleGenerateNow()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-xs hover:bg-indigo-700 disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {generating ? "Generating..." : "Generate Summary Now"}
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Digest history sidebar */}
        <aside className="w-60 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-3 hidden sm:block">
          <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            History
          </p>
          {digests.length === 0 ? (
            <p className="px-2 text-xs text-slate-500">
              {loading ? "Loading..." : "No digests generated yet."}
            </p>
          ) : (
            <div className="space-y-1">
              {digests.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setSelectedId(d.id)}
                  className={`w-full rounded-lg px-3 py-2 text-left transition ${
                    active?.id === d.id
                      ? "bg-indigo-50 text-indigo-800"
                      : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <div className="text-xs font-semibold">{d.digestDate}</div>
                  <div className="mt-0.5 flex items-center justify-between text-[11px] text-slate-500">
                    <span>{d.todos.length} to-dos</span>
                    <span>{d.triggeredBy}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>

        {/* Active Digest Body */}
        <div className="flex-1 overflow-y-auto p-5 lg:p-7">
          {!active ? (
            <div className="mx-auto max-w-lg rounded-2xl border border-slate-200 bg-white p-8 text-center">
              <Sparkles className="mx-auto h-8 w-8 text-indigo-500" />
              <h2 className="mt-3 text-base font-semibold text-slate-900">
                No Daily Summaries Yet
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                Enable Cloudflare Workers AI and the Daily Inbox Summary function in Settings to
                receive scheduled briefings with extracted To-Dos and reminders, or generate one on
                demand.
              </p>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-5">
              {/* Overview */}
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-slate-900">
                    Inbox Briefing · {active.digestDate}
                  </h2>
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] text-slate-600">
                    {active.sourceThreadCount} threads analyzed · {active.timezone}
                  </span>
                </div>
                <p className="mt-2.5 text-sm leading-relaxed text-slate-700">{active.overview}</p>
                {active.emailedTo && (
                  <p className="mt-2 text-xs text-emerald-700">
                    Digest emailed to {active.emailedTo}
                  </p>
                )}
              </div>

              {/* To-Dos */}
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <CheckSquare className="h-4 w-4 text-indigo-600" />
                  Action Items &amp; To-Dos ({active.todos.length})
                </h3>
                {active.todos.length === 0 ? (
                  <p className="mt-2 text-xs text-slate-500">No action items extracted.</p>
                ) : (
                  <ul className="mt-3 divide-y divide-slate-100">
                    {active.todos.map((todo) => (
                      <li
                        key={todo.id}
                        className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                      >
                        <button
                          type="button"
                          onClick={() => void handleToggleTodo(active.id, todo.id, !todo.done)}
                          className="flex flex-1 items-start gap-2.5 text-left"
                        >
                          {todo.done ? (
                            <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                          ) : (
                            <Square className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                          )}
                          <div>
                            <p
                              className={`text-sm ${
                                todo.done
                                  ? "text-slate-400 line-through"
                                  : "font-medium text-slate-800"
                              }`}
                            >
                              {todo.title}
                            </p>
                            {(todo.sender || todo.dueHint) && (
                              <p className="mt-0.5 text-xs text-slate-500">
                                {[todo.sender, todo.dueHint].filter(Boolean).join(" · ")}
                              </p>
                            )}
                          </div>
                        </button>
                        {todo.threadId && (
                          <button
                            type="button"
                            onClick={() => onOpenThread(todo.threadId!)}
                            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-indigo-600 hover:bg-indigo-50"
                          >
                            <span>Open</span>
                            <ExternalLink className="h-3 w-3" />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Reminders & Deadlines */}
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <CalendarClock className="h-4 w-4 text-amber-600" />
                  Reminders &amp; Deadlines ({active.reminders.length})
                </h3>
                {active.reminders.length === 0 ? (
                  <p className="mt-2 text-xs text-slate-500">No upcoming reminders found.</p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {active.reminders.map((rem, idx) => (
                      <div
                        key={`${rem.title}-${idx}`}
                        className="flex items-center justify-between gap-3 rounded-xl border border-amber-100 bg-amber-50/50 px-3.5 py-2.5"
                      >
                        <div>
                          <p className="text-sm font-medium text-slate-800">{rem.title}</p>
                          <p className="text-xs text-amber-800">{rem.when}</p>
                        </div>
                        {rem.threadId && (
                          <button
                            type="button"
                            onClick={() => onOpenThread(rem.threadId!)}
                            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-200 bg-white px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
                          >
                            Open
                            <ExternalLink className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* FYI Rollup */}
              {active.fyi.length > 0 && (
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <Bell className="h-4 w-4 text-slate-500" />
                    FYI Rollup ({active.fyi.length})
                  </h3>
                  <ul className="mt-2.5 space-y-1.5 text-sm text-slate-600">
                    {active.fyi.map((item, idx) => (
                      <li key={`${item.title}-${idx}`} className="flex items-center justify-between gap-2">
                        <span>• {item.title}</span>
                        {item.threadId && (
                          <button
                            type="button"
                            onClick={() => onOpenThread(item.threadId!)}
                            className="text-xs font-medium text-indigo-600 hover:underline"
                          >
                            View
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
