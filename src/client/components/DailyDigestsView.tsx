/**
 * @file src/client/components/DailyDigestsView.tsx
 * @description Tactile Soft UI view displaying generated Daily Inbox Summaries (overview,
 * interactive To-Dos, reminders/deadlines, and FYI rollups) with click-through thread navigation.
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
    <div className="neu-canvas flex h-full flex-1 flex-col overflow-hidden">
      <header className="neu-panel flex flex-wrap items-center justify-between gap-3 border-b border-[var(--neu-divider)] px-5 py-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onOpenMobileNav}
            className="neu-icon-btn h-8 w-8 lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </button>
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-[var(--neu-text)]">
              <Sparkles className="h-5 w-5 text-[var(--neu-coral-text)]" aria-hidden="true" />
              Daily Inbox Summaries
            </h1>
            <p className="text-xs text-[var(--neu-text-muted)]">
              Actionable To-Dos, reminders, and executive rollups built by Cloudflare Workers AI.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!settings.aiEnabled ? (
            <button
              type="button"
              onClick={onOpenAiSettings}
              className="neu-alert-warning rounded-full px-3.5 py-2 text-xs font-semibold"
            >
              Enable Cloudflare AI in Settings →
            </button>
          ) : (
            <button
              type="button"
              disabled={generating}
              onClick={() => void handleGenerateNow()}
              className="neu-btn-accent inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold"
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {generating ? "Generating..." : "Generate Summary Now"}
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Digest history sidebar */}
        <aside className="neu-panel hidden w-60 shrink-0 overflow-y-auto border-r border-[var(--neu-divider)] p-3 sm:block">
          <p className="mb-2.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--neu-text-muted)]">
            History
          </p>
          {digests.length === 0 ? (
            <p className="px-2 text-xs text-[var(--neu-text-muted)]">
              {loading ? "Loading..." : "No digests generated yet."}
            </p>
          ) : (
            <div className="space-y-1.5">
              {digests.map((d) => {
                const isSelected = active?.id === d.id;
                return (
                  <button
                    key={d.id}
                    type="button"
                    data-active={isSelected}
                    aria-current={isSelected ? "true" : undefined}
                    onClick={() => setSelectedId(d.id)}
                    className="neu-nav-item w-full rounded-2xl py-2.5 pl-4 pr-3 text-left"
                  >
                    <div className="text-xs font-semibold text-[var(--neu-text)]">
                      {d.digestDate}
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[11px] text-[var(--neu-text-muted)]">
                      <span>{d.todos.length} to-dos</span>
                      <span>{d.triggeredBy}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        {/* Active Digest Body */}
        <div className="flex-1 overflow-y-auto p-5 lg:p-7">
          {!active ? (
            <div className="neu-card mx-auto max-w-lg rounded-3xl p-8 text-center">
              <div className="neu-inset mx-auto flex h-14 w-14 items-center justify-center rounded-full text-[var(--neu-coral-text)]">
                <Sparkles className="h-6 w-6" aria-hidden="true" />
              </div>
              <h2 className="mt-4 text-base font-semibold text-[var(--neu-text)]">
                No Daily Summaries Yet
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-[var(--neu-text-muted)]">
                Enable Cloudflare Workers AI and the Daily Inbox Summary function in Settings to
                receive scheduled briefings with extracted To-Dos and reminders, or generate one on
                demand.
              </p>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-5">
              {/* Overview */}
              <div className="neu-card rounded-2xl p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-[var(--neu-text)]">
                    Inbox Briefing · {active.digestDate}
                  </h2>
                  <span className="neu-badge rounded-full px-3 py-0.5 text-[11px] font-medium">
                    {active.sourceThreadCount} threads analyzed · {active.timezone}
                  </span>
                </div>
                <p className="mt-2.5 text-sm leading-relaxed text-[var(--neu-text-secondary)]">
                  {active.overview}
                </p>
                {active.emailedTo && (
                  <p className="mt-2 text-xs font-medium text-[var(--neu-success-text)]">
                    Digest emailed to {active.emailedTo}
                  </p>
                )}
              </div>

              {/* To-Dos */}
              <div className="neu-card rounded-2xl p-5">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--neu-text)]">
                  <CheckSquare
                    className="h-4 w-4 text-[var(--neu-coral-text)]"
                    aria-hidden="true"
                  />
                  Action Items &amp; To-Dos ({active.todos.length})
                </h3>
                {active.todos.length === 0 ? (
                  <p className="mt-2 text-xs text-[var(--neu-text-muted)]">
                    No action items extracted.
                  </p>
                ) : (
                  <ul className="mt-3 divide-y divide-[var(--neu-divider)]">
                    {active.todos.map((todo) => (
                      <li
                        key={todo.id}
                        className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                      >
                        <button
                          type="button"
                          onClick={() => void handleToggleTodo(active.id, todo.id, !todo.done)}
                          className="flex min-h-[36px] flex-1 items-start gap-2.5 text-left"
                        >
                          {todo.done ? (
                            <CheckSquare
                              className="mt-0.5 h-4 w-4 shrink-0 text-[var(--neu-success-text)]"
                              aria-hidden="true"
                            />
                          ) : (
                            <Square
                              className="mt-0.5 h-4 w-4 shrink-0 text-[var(--neu-text-muted)]"
                              aria-hidden="true"
                            />
                          )}
                          <div>
                            <p
                              className={`text-sm ${
                                todo.done
                                  ? "text-[var(--neu-text-muted)] line-through"
                                  : "font-medium text-[var(--neu-text)]"
                              }`}
                            >
                              {todo.title}
                            </p>
                            {(todo.sender || todo.dueHint) && (
                              <p className="mt-0.5 text-xs text-[var(--neu-text-muted)]">
                                {[todo.sender, todo.dueHint].filter(Boolean).join(" · ")}
                              </p>
                            )}
                          </div>
                        </button>
                        {todo.threadId && (
                          <button
                            type="button"
                            onClick={() => onOpenThread(todo.threadId!)}
                            className="neu-btn inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-[11px] font-semibold text-[var(--neu-coral-text)]"
                          >
                            <span>Open</span>
                            <ExternalLink className="h-3 w-3" aria-hidden="true" />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Reminders & Deadlines */}
              <div className="neu-card rounded-2xl p-5">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--neu-text)]">
                  <CalendarClock
                    className="h-4 w-4 text-[var(--neu-warning-text)]"
                    aria-hidden="true"
                  />
                  Reminders &amp; Deadlines ({active.reminders.length})
                </h3>
                {active.reminders.length === 0 ? (
                  <p className="mt-2 text-xs text-[var(--neu-text-muted)]">
                    No upcoming reminders found.
                  </p>
                ) : (
                  <div className="mt-3 space-y-2.5">
                    {active.reminders.map((rem, idx) => (
                      <div
                        key={`${rem.title}-${idx}`}
                        className="neu-alert-warning flex items-center justify-between gap-3 rounded-xl px-4 py-2.5"
                      >
                        <div>
                          <p className="text-sm font-semibold">{rem.title}</p>
                          <p className="text-xs opacity-90">{rem.when}</p>
                        </div>
                        {rem.threadId && (
                          <button
                            type="button"
                            onClick={() => onOpenThread(rem.threadId!)}
                            className="neu-btn inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-[11px] font-semibold"
                          >
                            Open
                            <ExternalLink className="h-3 w-3" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* FYI Rollup */}
              {active.fyi.length > 0 && (
                <div className="neu-card rounded-2xl p-5">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--neu-text)]">
                    <Bell
                      className="h-4 w-4 text-[var(--neu-text-secondary)]"
                      aria-hidden="true"
                    />
                    FYI Rollup ({active.fyi.length})
                  </h3>
                  <ul className="mt-2.5 space-y-2 text-sm text-[var(--neu-text-secondary)]">
                    {active.fyi.map((item, idx) => (
                      <li
                        key={`${item.title}-${idx}`}
                        className="flex items-center justify-between gap-2"
                      >
                        <span>• {item.title}</span>
                        {item.threadId && (
                          <button
                            type="button"
                            onClick={() => onOpenThread(item.threadId!)}
                            className="text-xs font-semibold text-[var(--neu-coral-text)] hover:underline"
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
