/**
 * @file src/shared/types.ts
 * @description Shared TypeScript domain models used across the Cloudflare Worker backend,
 * MCP/REST agent APIs, and the React web client.
 */

/** Standard mail folders displayed in the UI and filtered by API queries. */
export type FolderName =
  | "inbox"
  | "pending_approval"
  | "sent"
  | "drafts"
  | "archive"
  | "trash";

/** Lifecycle states for individual messages stored in D1. */
export type MessageStatus =
  | "received"
  | "draft"
  | "pending_approval"
  | "sent"
  | "delivered"
  | "delayed"
  | "bounced"
  | "complained"
  | "failed"
  | "rejected";

/** Direction of a message relative to this mailbox. */
export type MessageDirection = "inbound" | "outbound";

/** Permission tiers assigned to external AI agent API keys. */
export type AgentScope = "read_only" | "read_draft" | "read_write";

/** Built-in AI functions that can be toggled on/off and granted to agents. */
export type BuiltInAiFunction = "daily_summary" | "important_auto_reply" | "triage";

/** Semantic categories produced by AI triage. */
export type AiCategory =
  | "action_required"
  | "fyi"
  | "newsletter"
  | "receipt"
  | "automated"
  | "personal";

/** Outbound mail delivery provider configured for this Postlet instance. */
export type MailProviderId = "resend" | "cloudflare" | "ses";

/** Priority tiers produced by AI triage. */
export type AiPriority = "high" | "normal" | "low";

/** How the Important Email Auto-Reply function executes when triggered. */
export type AutoReplyMode = "approval" | "auto_send";

/** Configured owner sender/alias address record. */
export interface AddressRecord {
  id: string;
  email: string;
  displayName: string;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Delivery webhook event timeline entry recorded from Resend. */
export interface DeliveryEvent {
  type: string;
  timestamp: string;
  detail?: string;
}

/** Binary attachment metadata stored in D1 and backed by Cloudflare R2. */
export interface AttachmentRecord {
  id: string;
  messageId: string | null;
  resendAttachmentId: string | null;
  r2Key: string;
  filename: string;
  contentType: string;
  contentDisposition: string;
  contentId: string | null;
  sizeBytes: number;
  createdAt: string;
}

/** Individual message record within a conversation thread. */
export interface MessageRecord {
  id: string;
  threadId: string;
  resendEmailId: string | null;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  referencesHeader: string | null;
  direction: MessageDirection;
  status: MessageStatus;
  fromAddress: string;
  fromName: string;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  replyTo: string | null;
  subject: string;
  textBody: string;
  htmlBody: string;
  headers: Record<string, string>;
  isRead: boolean;
  folder: string;
  createdByAgentKeyId: string | null;
  createdByActor: string;
  deliveryError: string | null;
  deliveryEvents: DeliveryEvent[];
  attachments: AttachmentRecord[];
  createdAt: string;
  updatedAt: string;
}

/** Lightweight thread item returned by list and search queries. */
export interface ThreadSummary {
  id: string;
  subject: string;
  snippet: string;
  participants: string[];
  recipientAddress: string;
  folder: string;
  lastMessageAt: string;
  messageCount: number;
  unreadCount: number;
  aiSummary: string | null;
  aiCategory: AiCategory | null;
  aiPriority: AiPriority | null;
  aiUpdatedAt: string | null;
  autoRepliedAt: string | null;
  latestStatus: MessageStatus | null;
  hasPendingApproval: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Full conversation thread including ordered messages and attachments. */
export interface ThreadDetail extends ThreadSummary {
  messages: MessageRecord[];
}

/** Sidebar folder and badge counts. */
export interface FolderCounts {
  inboxUnread: number;
  inboxTotal: number;
  pendingApproval: number;
  drafts: number;
  sent: number;
  archive: number;
  trash: number;
}

/** Operational and Cloudflare Workers AI settings stored in D1 `app_settings`. */
export interface AppSettings {
  mailDomain: string;
  mailDomains: string[];
  catchAllEnabled: boolean;
  aiEnabled: boolean;
  aiModel: string;
  aiDailyCap: number;
  aiDailyCount: number;
  aiDailyDate: string;
  aiAutoTriageEnabled: boolean;
  aiDailySummaryEnabled: boolean;
  aiDailySummaryHour: number;
  aiDailySummaryTimezone: string;
  aiDailySummaryEmailCopy: boolean;
  aiDailySummaryLastRunDate: string;
  aiImportantAutoReplyEnabled: boolean;
  aiImportantAutoReplyMode: AutoReplyMode;
  aiImportantAutoReplyInstructions: string;
  aiImportantAutoReplyCooldownHours: number;
}

/** Single actionable To-Do extracted inside a Daily Inbox Summary. */
export interface DigestTodoItem {
  id: string;
  title: string;
  done: boolean;
  threadId: string | null;
  sender: string | null;
  dueHint: string | null;
}

/** Reminder or deadline extracted inside a Daily Inbox Summary. */
export interface DigestReminderItem {
  title: string;
  when: string;
  threadId: string | null;
}

/** Low-urgency informational rollup item inside a Daily Inbox Summary. */
export interface DigestFyiItem {
  title: string;
  threadId: string | null;
}

/** Persisted Daily Inbox Summary generated by Workers AI or an authorized agent. */
export interface DailyDigest {
  id: string;
  digestDate: string;
  timezone: string;
  overview: string;
  todos: DigestTodoItem[];
  reminders: DigestReminderItem[];
  fyi: DigestFyiItem[];
  sourceThreadCount: number;
  emailedTo: string | null;
  triggeredBy: string;
  createdAt: string;
}

/** Public metadata for an agent API key (never contains `keyHash`). */
export interface AgentKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  scope: AgentScope;
  allowedAddressId: string | null;
  allowedAddressEmail: string | null;
  allowedRecipientDomains: string[] | null;
  allowedFunctions: BuiltInAiFunction[];
  rateLimitPerHour: number;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Connection snippets displayed once when a new agent API key is created. */
export interface AgentOnboardingSnippets {
  mcpConfigJson: string;
  curlCommand: string;
  openApiUrl: string;
}

/** Unified audit entry for external agent calls, built-in AI, and owner actions. */
export interface AuditLogRecord {
  id: string;
  actorType: "agent_key" | "postlet_ai" | "owner";
  agentKeyId: string | null;
  actorLabel: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  status: "allowed" | "denied" | "error";
  details: Record<string, unknown>;
  createdAt: string;
}

/** Metadata returned by `/api/admin/meta` to initialize the Web UI. */
export interface AdminMetaResponse {
  appName: string;
  appVersion: string;
  ownerEmail: string;
  mailProvider: MailProviderId;
  selfHostedTrackingEnabled: boolean;
  counts: FolderCounts;
  domainUnreadCounts: Record<string, number>;
  settings: AppSettings;
  addresses: AddressRecord[];
  latestDigestDate: string | null;
}
