/**
 * @file src/client/components/settings/AiAgentTab.tsx
 * @description Tactile Soft UI settings tab for Postlet's built-in Cloudflare Workers AI agent
 * (`postlet-ai`). Provides tactile hardware toggle switches, glowing coral daily cap meter,
 * Auto-Triage, Daily Inbox Summary configuration, and Important Email Auto-Reply settings.
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
      <div className="neu-card rounded-2xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className={`mt-0.5 flex h-10 w-10 items-center justify-center rounded-2xl ${
                aiEnabled ? "neu-btn-accent" : "neu-inset text-[var(--neu-text-muted)]"
              }`}
            >
              <Bot className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-[var(--neu-text)]">
                  Cloudflare Workers AI Agent (Default)
                </h2>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                    aiEnabled ? "neu-badge-success" : "neu-badge"
                  }`}
                >
                  {aiEnabled ? "Enabled" : "Disabled (Default)"}
                </span>
              </div>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--neu-text-muted)]">
                Uses your native Cloudflare{" "}
                <code className="neu-inset rounded px-1.5 py-0.5">AI</code> binding (10,000 free
                Neurons/day included on Cloudflare Workers). Disabled initially so zero inference
                runs until you toggle it on.
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={saving}
            onClick={() => void handleToggleMaster(!aiEnabled)}
            className={`rounded-full px-4 py-2 text-xs font-semibold ${
              aiEnabled ? "neu-btn" : "neu-btn-accent"
            }`}
          >
            {aiEnabled ? "Disable AI Agent" : "Enable Cloudflare AI"}
          </button>
        </div>

        {/* Model + Daily Cap Meter */}
        <div className="mt-5 grid gap-4 border-t border-[var(--neu-divider)] pt-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="ai-model"
              className="block text-xs font-medium text-[var(--neu-text-secondary)]"
            >
              Workers AI Model
            </label>
            <select
              id="ai-model"
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value)}
              className="neu-input mt-1.5 w-full rounded-xl px-3 py-2 text-sm"
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
              <label htmlFor="ai-cap" className="font-medium text-[var(--neu-text-secondary)]">
                Daily Free-Tier Safety Cap (calls/day UTC)
              </label>
              <span className="font-mono text-[var(--neu-text-muted)]">
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
              className="neu-input mt-1.5 w-full rounded-xl px-3 py-2 text-sm"
            />
            <div className="neu-progress-track mt-2.5 h-2 w-full">
              <div
                className="neu-progress-fill"
                style={{
                  width: `${usagePct}%`,
                  ...(usagePct >= 90
                    ? { background: "var(--neu-danger-solid)" }
                    : {}),
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Auto-Triage Inbound Mail */}
      <div className="neu-card rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-2.5">
            <Sparkles className="mt-0.5 h-4 w-4 text-[var(--neu-coral-text)]" aria-hidden="true" />
            <div>
              <h3 className="text-sm font-semibold text-[var(--neu-text)]">
                Auto-Triage Inbound Mail
              </h3>
              <p className="mt-0.5 text-xs text-[var(--neu-text-muted)]">
                Automatically classify incoming threads by priority (High/Normal/Low) and category
                (Action Required, Receipt, Newsletter, etc.) in the background.
              </p>
            </div>
          </div>
          <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2.5 text-xs font-medium text-[var(--neu-text)] select-none">
            <span>Enabled</span>
            <input
              type="checkbox"
              role="switch"
              {...({ switch: "" } as Record<string, string>)}
              checked={autoTriage}
              onChange={(e) => setAutoTriage(e.target.checked)}
              className="neu-switch"
            />
          </label>
        </div>
      </div>

      {/* Built-in Function 1: Daily Inbox Summary */}
      <div className="neu-card rounded-2xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <CalendarClock
              className="mt-0.5 h-4 w-4 text-[var(--neu-coral-text)]"
              aria-hidden="true"
            />
            <div>
              <h3 className="text-sm font-semibold text-[var(--neu-text)]">
                Built-In Function: Daily Inbox Summary (To-Dos &amp; Reminders)
              </h3>
              <p className="mt-0.5 text-xs text-[var(--neu-text-muted)]">
                Generates an executive overview, actionable To-Dos, and upcoming reminders from your
                inbox on your chosen daily schedule (also callable by MCP/REST agents).
              </p>
            </div>
          </div>

          <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2.5 text-xs font-medium text-[var(--neu-text)] select-none">
            <span>Enabled</span>
            <input
              type="checkbox"
              role="switch"
              {...({ switch: "" } as Record<string, string>)}
              checked={dailySummaryEnabled}
              onChange={(e) => setDailySummaryEnabled(e.target.checked)}
              className="neu-switch"
            />
          </label>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <label
              htmlFor="summary-hour"
              className="block text-xs font-medium text-[var(--neu-text-secondary)]"
            >
              Schedule Hour (Local Time)
            </label>
            <select
              id="summary-hour"
              value={dailySummaryHour}
              onChange={(e) => setDailySummaryHour(Number.parseInt(e.target.value, 10))}
              className="neu-input mt-1.5 w-full rounded-xl px-3 py-2 text-sm"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="summary-tz"
              className="block text-xs font-medium text-[var(--neu-text-secondary)]"
            >
              Timezone
            </label>
            <select
              id="summary-tz"
              value={dailySummaryTimezone}
              onChange={(e) => setDailySummaryTimezone(e.target.value)}
              className="neu-input mt-1.5 w-full rounded-xl px-3 py-2 text-sm"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end">
            <label className="neu-inset flex min-h-[44px] w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-3 py-1.5 text-xs font-medium text-[var(--neu-text)] select-none">
              <span>Email copy to default address</span>
              <input
                type="checkbox"
                role="switch"
                {...({ switch: "" } as Record<string, string>)}
                checked={dailySummaryEmailCopy}
                onChange={(e) => setDailySummaryEmailCopy(e.target.checked)}
                className="neu-switch"
              />
            </label>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-[var(--neu-text-muted)]">
            Last run: {settings.aiDailySummaryLastRunDate || "Never"}
          </span>
          <button
            type="button"
            disabled={!aiEnabled || runningSummary}
            onClick={() => void handleRunSummaryNow()}
            className="neu-btn-soft-coral rounded-full px-3.5 py-1.5 text-xs font-semibold"
          >
            {runningSummary ? "Generating..." : "Run Summary Now"}
          </button>
        </div>
      </div>

      {/* Built-in Function 2: Important Email Auto-Reply */}
      <div className="neu-card rounded-2xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <MailCheck className="mt-0.5 h-4 w-4 text-[var(--neu-coral-text)]" aria-hidden="true" />
            <div>
              <h3 className="text-sm font-semibold text-[var(--neu-text)]">
                Built-In Function: Important Email Auto-Reply
              </h3>
              <p className="mt-0.5 text-xs text-[var(--neu-text-muted)]">
                Drafts or sends a contextual response when high-priority human mail arrives.
              </p>
            </div>
          </div>

          <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2.5 text-xs font-medium text-[var(--neu-text)] select-none">
            <span>Enabled</span>
            <input
              type="checkbox"
              role="switch"
              {...({ switch: "" } as Record<string, string>)}
              checked={autoReplyEnabled}
              onChange={(e) => setAutoReplyEnabled(e.target.checked)}
              className="neu-switch"
            />
          </label>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="autoreply-mode"
              className="block text-xs font-medium text-[var(--neu-text-secondary)]"
            >
              Execution Mode
            </label>
            <select
              id="autoreply-mode"
              value={autoReplyMode}
              onChange={(e) => setAutoReplyMode(e.target.value as AutoReplyMode)}
              className="neu-input mt-1.5 w-full rounded-xl px-3 py-2 text-sm"
            >
              <option value="approval">Queue for Approval (Recommended)</option>
              <option value="auto_send">Auto-Send Immediately</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="autoreply-cooldown"
              className="block text-xs font-medium text-[var(--neu-text-secondary)]"
            >
              Cooldown Per Sender / Thread (hours)
            </label>
            <input
              id="autoreply-cooldown"
              type="number"
              min={1}
              max={720}
              value={autoReplyCooldown}
              onChange={(e) => setAutoReplyCooldown(Number.parseInt(e.target.value, 10) || 24)}
              className="neu-input mt-1.5 w-full rounded-xl px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="mt-3">
          <label
            htmlFor="autoreply-instructions"
            className="block text-xs font-medium text-[var(--neu-text-secondary)]"
          >
            Reply Persona &amp; Instructions
          </label>
          <textarea
            id="autoreply-instructions"
            rows={3}
            value={autoReplyInstructions}
            onChange={(e) => setAutoReplyInstructions(e.target.value)}
            className="neu-input mt-1.5 w-full rounded-xl p-3 text-sm"
          />
        </div>

        <div className="neu-alert-success mt-3.5 flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-xs">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
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
          className="neu-btn-accent rounded-full px-6 py-2.5 text-xs font-semibold"
        >
          {saving ? "Saving..." : "Save AI Agent Configuration"}
        </button>
      </div>
    </div>
  );
}
