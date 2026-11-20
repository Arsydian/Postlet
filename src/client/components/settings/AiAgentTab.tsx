/**
 * @file src/client/components/settings/AiAgentTab.tsx
 * @description Settings tab for Postlet's built-in Cloudflare Workers AI agent (`postlet-ai`).
 * Disabled initially by default; provides master toggle, free-tier daily cap meter,
 * Auto-Triage toggle, Daily Inbox Summary configuration, and Important Email Auto-Reply settings.
 */

import { Bot, CalendarClock, MailCheck, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";
import type { AppSettings, AutoReplyMode } from "../../../shared/types";
import { api } from "../../lib/api";

interface AiAgentTabProps {
  settings: AppSettings;
  onRefresh: () => Promise<void>;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

const MODELS = [
  {
    id: "@cf/meta/llama-3.2-3b-instruct",
    label: "Llama 3.2 3B Instruct (Fastest · Free-Tier Recommended)",
  },
  {
    id: "@cf/meta/llama-3.1-8b-instruct",
    label: "Llama 3.1 8B Instruct (Balanced)",
  },
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    label: "Llama 3.3 70B FP8 Fast (Higher Neuron Usage)",
  },
];

const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Australia/Sydney",
];

export function AiAgentTab({ settings, onRefresh, onSuccess, onError }: AiAgentTabProps) {
  const [aiEnabled, setAiEnabled] = useState(settings.aiEnabled);
  const [aiModel, setAiModel] = useState(settings.aiModel);
  const [aiDailyCap, setAiDailyCap] = useState(settings.aiDailyCap);
  const [autoTriage, setAutoTriage] = useState(settings.aiAutoTriageEnabled);

  const [dailySummaryEnabled, setDailySummaryEnabled] = useState(settings.aiDailySummaryEnabled);
  const [dailySummaryHour, setDailySummaryHour] = useState(settings.aiDailySummaryHour);
  const [dailySummaryTimezone, setDailySummaryTimezone] = useState(
    settings.aiDailySummaryTimezone,
  );
  const [dailySummaryEmailCopy, setDailySummaryEmailCopy] = useState(
    settings.aiDailySummaryEmailCopy,
  );

  const [autoReplyEnabled, setAutoReplyEnabled] = useState(settings.aiImportantAutoReplyEnabled);
  const [autoReplyMode, setAutoReplyMode] = useState<AutoReplyMode>(
    settings.aiImportantAutoReplyMode,
  );
  const [autoReplyInstructions, setAutoReplyInstructions] = useState(
    settings.aiImportantAutoReplyInstructions,
  );
  const [autoReplyCooldown, setAutoReplyCooldown] = useState(
    settings.aiImportantAutoReplyCooldownHours,
  );

  const [saving, setSaving] = useState(false);
  const [runningSummary, setRunningSummary] = useState(false);

  const usagePct = Math.min(
    100,
    Math.round((settings.aiDailyCount / Math.max(1, settings.aiDailyCap)) * 100),
  );

  async function saveAiSettings(overridePatch?: Partial<AppSettings>) {
    setSaving(true);
    try {
      await api.updateSettings({
        aiEnabled,
        aiModel,
        aiDailyCap: Number(aiDailyCap) || 50,
        aiAutoTriageEnabled: autoTriage,
        aiDailySummaryEnabled: dailySummaryEnabled,
        aiDailySummaryHour: Number(dailySummaryHour),
        aiDailySummaryTimezone: dailySummaryTimezone,
        aiDailySummaryEmailCopy: dailySummaryEmailCopy,
        aiImportantAutoReplyEnabled: autoReplyEnabled,
        aiImportantAutoReplyMode: autoReplyMode,
        aiImportantAutoReplyInstructions: autoReplyInstructions,
        aiImportantAutoReplyCooldownHours: Number(autoReplyCooldown) || 24,
        ...(overridePatch ?? {}),
      });
      await onRefresh();
      onSuccess("Cloudflare AI Agent settings saved.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to save AI settings");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleMaster(next: boolean) {
    setAiEnabled(next);
    await saveAiSettings({ aiEnabled: next });
  }

  async function handleRunSummaryNow() {
    setRunningSummary(true);
    try {
      await api.generateDigest(dailySummaryEmailCopy);
      await onRefresh();
      onSuccess("Daily Inbox Summary generated. Check Daily Digests in the sidebar.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to run summary");
    } finally {
      setRunningSummary(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Master Toggle Banner */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className={`mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl ${
                aiEnabled ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500"
              }`}
            >
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-slate-900">
                  Cloudflare Workers AI Agent (Default)
                </h2>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                    aiEnabled
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {aiEnabled ? "Enabled" : "Disabled (Default)"}
                </span>
              </div>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">
                Uses your native Cloudflare <code className="rounded bg-slate-100 px-1">AI</code>{" "}
                binding (10,000 free Neurons/day included on Cloudflare Workers). Disabled initially
                so zero inference runs until you toggle it on.
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={saving}
            onClick={() => void handleToggleMaster(!aiEnabled)}
            className={`rounded-xl px-4 py-2 text-xs font-semibold shadow-xs transition ${
              aiEnabled
                ? "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                : "bg-indigo-600 text-white hover:bg-indigo-700"
            }`}
          >
            {aiEnabled ? "Disable AI Agent" : "Enable Cloudflare AI"}
          </button>
        </div>

        {/* Model + Daily Cap Meter */}
        <div className="mt-5 grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
          <div>
            <label htmlFor="ai-model" className="block text-xs font-medium text-slate-700">
              Workers AI Model
            </label>
            <select
              id="ai-model"
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="ai-cap" className="font-medium text-slate-700">
                Daily Free-Tier Safety Cap (calls/day UTC)
              </label>
              <span className="font-mono text-slate-500">
                {settings.aiDailyCount} / {aiDailyCap} used
              </span>
            </div>
            <input
              id="ai-cap"
              type="number"
              min={1}
              max={2000}
              value={aiDailyCap}
              onChange={(e) => setAiDailyCap(Number.parseInt(e.target.value, 10) || 50)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full transition-all ${
                  usagePct >= 90 ? "bg-rose-500" : "bg-indigo-600"
                }`}
                style={{ width: `${usagePct}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Auto-Triage Inbound Mail */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-2.5">
            <Sparkles className="mt-0.5 h-4 w-4 text-indigo-600" />
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Auto-Triage Inbound Mail</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Automatically classify incoming threads by priority (High/Normal/Low) and category
                (Action Required, Receipt, Newsletter, etc.) in the background.
              </p>
            </div>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700">
            <input
              type="checkbox"
              checked={autoTriage}
              onChange={(e) => setAutoTriage(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600"
            />
            Enabled
          </label>
        </div>
      </div>

      {/* Built-in Function 1: Daily Inbox Summary */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <CalendarClock className="mt-0.5 h-4 w-4 text-indigo-600" />
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Built-In Function: Daily Inbox Summary (To-Dos &amp; Reminders)
              </h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Generates an executive overview, actionable To-Dos, and upcoming reminders from your
                inbox on your chosen daily schedule (also callable by MCP/REST agents).
              </p>
            </div>
          </div>

          <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700">
            <input
              type="checkbox"
              checked={dailySummaryEnabled}
              onChange={(e) => setDailySummaryEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600"
            />
            Enabled
          </label>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="summary-hour" className="block text-xs font-medium text-slate-700">
              Schedule Hour (Local Time)
            </label>
            <select
              id="summary-hour"
              value={dailySummaryHour}
              onChange={(e) => setDailySummaryHour(Number.parseInt(e.target.value, 10))}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="summary-tz" className="block text-xs font-medium text-slate-700">
              Timezone
            </label>
            <select
              id="summary-tz"
              value={dailySummaryTimezone}
              onChange={(e) => setDailySummaryTimezone(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end">
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700 w-full">
              <input
                type="checkbox"
                checked={dailySummaryEmailCopy}
                onChange={(e) => setDailySummaryEmailCopy(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600"
              />
              Email copy to default address
            </label>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-slate-500">
            Last run: {settings.aiDailySummaryLastRunDate || "Never"}
          </span>
          <button
            type="button"
            disabled={!aiEnabled || runningSummary}
            onClick={() => void handleRunSummaryNow()}
            className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
          >
            {runningSummary ? "Generating..." : "Run Summary Now"}
          </button>
        </div>
      </div>

      {/* Built-in Function 2: Important Email Auto-Reply */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <MailCheck className="mt-0.5 h-4 w-4 text-indigo-600" />
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Built-In Function: Important Email Auto-Reply
              </h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Drafts or sends a contextual response when high-priority human mail arrives.
              </p>
            </div>
          </div>

          <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700">
            <input
              type="checkbox"
              checked={autoReplyEnabled}
              onChange={(e) => setAutoReplyEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600"
            />
            Enabled
          </label>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="autoreply-mode" className="block text-xs font-medium text-slate-700">
              Execution Mode
            </label>
            <select
              id="autoreply-mode"
              value={autoReplyMode}
              onChange={(e) => setAutoReplyMode(e.target.value as AutoReplyMode)}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            >
              <option value="approval">Queue for Approval (Recommended)</option>
              <option value="auto_send">Auto-Send Immediately</option>
            </select>
          </div>

          <div>
            <label htmlFor="autoreply-cooldown" className="block text-xs font-medium text-slate-700">
              Cooldown Per Sender / Thread (hours)
            </label>
            <input
              id="autoreply-cooldown"
              type="number"
              min={1}
              max={720}
              value={autoReplyCooldown}
              onChange={(e) => setAutoReplyCooldown(Number.parseInt(e.target.value, 10) || 24)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>
        </div>

        <div className="mt-3">
          <label
            htmlFor="autoreply-instructions"
            className="block text-xs font-medium text-slate-700"
          >
            Reply Persona &amp; Instructions
          </label>
          <textarea
            id="autoreply-instructions"
            rows={3}
            value={autoReplyInstructions}
            onChange={(e) => setAutoReplyInstructions(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-200 p-3 text-sm focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3.5 py-2.5 text-xs text-emerald-900">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <span>
            <strong>RFC 3834 Loop Protection Active:</strong> Automatically skips{" "}
            <code>noreply@</code>, mailing lists (<code>List-Unsubscribe</code>),{" "}
            <code>Auto-Submitted</code> headers, own domain addresses, newsletters/receipts, and
            enforces the sender cooldown window.
          </span>
        </div>
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          type="button"
          disabled={saving}
          onClick={() => void saveAiSettings()}
          className="rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save AI Agent Configuration"}
        </button>
      </div>
    </div>
  );
}
