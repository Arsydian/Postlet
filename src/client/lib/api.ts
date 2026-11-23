/**
 * @file src/client/lib/api.ts
 * @description Typed fetch client for Postlet's Zero-Trust-protected `/api/admin/*` routes.
 */

import type {
  AddressRecord,
  AdminMetaResponse,
  AgentKeyRecord,
  AgentOnboardingSnippets,
  AgentScope,
  AppSettings,
  AttachmentRecord,
  AuditLogRecord,
  BuiltInAiFunction,
  DailyDigest,
  FolderName,
  MessageRecord,
  ThreadDetail,
  ThreadSummary,
} from "../../shared/types";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "X-Postlet-CSRF": "1",
      ...(init?.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const errPayload = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    throw new ApiError(
      errPayload.error || `Request failed (${res.status})`,
      res.status,
      errPayload.code,
    );
  }
  return (await res.json()) as T;
}

export const api = {
  getMeta(): Promise<AdminMetaResponse> {
    return requestJson<AdminMetaResponse>("/api/admin/meta");
  },

  listThreads(params: {
    folder?: FolderName;
    address?: string;
    domain?: string;
    unread?: boolean;
    priority?: string;
    category?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ threads: ThreadSummary[] }> {
    const sp = new URLSearchParams();
    if (params.folder) sp.set("folder", params.folder);
    if (params.address) sp.set("address", params.address);
    if (params.domain) sp.set("domain", params.domain);
    if (params.unread) sp.set("unread", "true");
    if (params.priority) sp.set("priority", params.priority);
    if (params.category) sp.set("category", params.category);
    if (params.q) sp.set("q", params.q);
    if (params.limit !== undefined) sp.set("limit", String(params.limit));
    if (params.offset !== undefined) sp.set("offset", String(params.offset));
    return requestJson<{ threads: ThreadSummary[] }>(`/api/admin/threads?${sp.toString()}`);
  },

  getThread(id: string): Promise<{ thread: ThreadDetail }> {
    return requestJson<{ thread: ThreadDetail }>(`/api/admin/threads/${encodeURIComponent(id)}`);
  },

  updateThread(
    id: string,
    patch: { folder?: "inbox" | "archive" | "trash"; isRead?: boolean },
  ): Promise<{ thread: ThreadSummary }> {
    return requestJson<{ thread: ThreadSummary }>(`/api/admin/threads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },

  deleteThread(id: string): Promise<{ ok: boolean }> {
    return requestJson<{ ok: boolean }>(`/api/admin/threads/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  sendOrDraftMessage(payload: {
    mode: "send" | "draft" | "pending_approval";
    fromAddressId?: string;
    fromAddress?: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    textBody: string;
    htmlBody: string;
    threadId?: string;
    replyToMessageId?: string;
    forwardMessageId?: string;
    attachmentIds?: string[];
    trackOpensAndClicks?: boolean;
  }): Promise<{ message: MessageRecord; threadId: string }> {
    return requestJson<{ message: MessageRecord; threadId: string }>("/api/admin/messages", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  updateDraftMessage(
    id: string,
    payload: {
      mode: "draft" | "send";
      fromAddressId?: string;
      fromAddress?: string;
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      textBody: string;
      htmlBody: string;
      attachmentIds?: string[];
      trackOpensAndClicks?: boolean;
    },
  ): Promise<{ message: MessageRecord; threadId: string }> {
    return requestJson<{ message: MessageRecord; threadId: string }>(
      `/api/admin/messages/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      },
    );
  },

  deleteDraftMessage(id: string): Promise<{ ok: boolean; threadDeleted: boolean }> {
    return requestJson<{ ok: boolean; threadDeleted: boolean }>(
      `/api/admin/messages/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },

  approveMessage(
    id: string,
    edits?: {
      to?: string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      textBody?: string;
      htmlBody?: string;
    },
  ): Promise<{ message: MessageRecord }> {
    return requestJson<{ message: MessageRecord }>(
      `/api/admin/messages/${encodeURIComponent(id)}/approve`,
      {
        method: "POST",
        body: JSON.stringify(edits ?? {}),
      },
    );
  },

  rejectMessage(id: string): Promise<{ ok: boolean }> {
    return requestJson<{ ok: boolean }>(
      `/api/admin/messages/${encodeURIComponent(id)}/reject`,
      { method: "POST" },
    );
  },

  uploadAttachment(file: File): Promise<{ attachment: AttachmentRecord }> {
    const form = new FormData();
    form.append("file", file);
    return requestJson<{ attachment: AttachmentRecord }>("/api/admin/attachments", {
      method: "POST",
      body: form,
    });
  },

  listAddresses(): Promise<{ addresses: AddressRecord[] }> {
    return requestJson<{ addresses: AddressRecord[] }>("/api/admin/addresses");
  },

  createAddress(payload: {
    email: string;
    displayName?: string;
    isDefault?: boolean;
  }): Promise<{ address: AddressRecord }> {
    return requestJson<{ address: AddressRecord }>("/api/admin/addresses", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  updateAddress(
    id: string,
    patch: { displayName?: string; isDefault?: boolean; isActive?: boolean },
  ): Promise<{ address: AddressRecord }> {
    return requestJson<{ address: AddressRecord }>(`/api/admin/addresses/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },

  deleteAddress(id: string): Promise<{ ok: boolean }> {
    return requestJson<{ ok: boolean }>(`/api/admin/addresses/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  updateSettings(patch: Partial<AppSettings>): Promise<{ settings: AppSettings }> {
    return requestJson<{ settings: AppSettings }>("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },

  summarizeThread(threadId: string, force = false): Promise<{ summary: string; cached: boolean }> {
    return requestJson<{ summary: string; cached: boolean }>(
      `/api/admin/ai/threads/${encodeURIComponent(threadId)}/summary?force=${String(force)}`,
      { method: "POST" },
    );
  },

  triageThread(
    threadId: string,
    force = false,
  ): Promise<{ category: string; priority: string; summary: string }> {
    return requestJson<{ category: string; priority: string; summary: string }>(
      `/api/admin/ai/threads/${encodeURIComponent(threadId)}/triage?force=${String(force)}`,
      { method: "POST" },
    );
  },

  suggestReply(threadId: string, guidance = ""): Promise<{ replyText: string }> {
    return requestJson<{ replyText: string }>(
      `/api/admin/ai/threads/${encodeURIComponent(threadId)}/suggest-reply`,
      {
        method: "POST",
        body: JSON.stringify({ guidance }),
      },
    );
  },

  runImportantAutoReply(
    threadId: string,
    force = true,
  ): Promise<{ executed: boolean; action: string; reason?: string; messageId?: string }> {
    return requestJson<{ executed: boolean; action: string; reason?: string; messageId?: string }>(
      `/api/admin/ai/threads/${encodeURIComponent(threadId)}/auto-reply`,
      {
        method: "POST",
        body: JSON.stringify({ force }),
      },
    );
  },

  listDigests(): Promise<{ digests: DailyDigest[] }> {
    return requestJson<{ digests: DailyDigest[] }>("/api/admin/digests");
  },

  generateDigest(emailCopy = false): Promise<{ digest: DailyDigest }> {
    return requestJson<{ digest: DailyDigest }>("/api/admin/digests/generate", {
      method: "POST",
      body: JSON.stringify({ emailCopy }),
    });
  },

  toggleDigestTodo(digestId: string, todoId: string, done: boolean): Promise<{ digest: DailyDigest }> {
    return requestJson<{ digest: DailyDigest }>(
      `/api/admin/digests/${encodeURIComponent(digestId)}/todos/${encodeURIComponent(todoId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ done }),
      },
    );
  },

  listAgentKeys(): Promise<{ keys: AgentKeyRecord[] }> {
    return requestJson<{ keys: AgentKeyRecord[] }>("/api/admin/agent-keys");
  },

  createAgentKey(payload: {
    name: string;
    scope: AgentScope;
    allowedAddressId?: string | null;
    allowedRecipientDomains?: string[] | null;
    allowedFunctions?: BuiltInAiFunction[];
    rateLimitPerHour?: number;
  }): Promise<{
    key: AgentKeyRecord;
    plaintextSecret: string;
    snippets: AgentOnboardingSnippets;
  }> {
    return requestJson("/api/admin/agent-keys", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  revokeAgentKey(id: string): Promise<{ ok: boolean }> {
    return requestJson<{ ok: boolean }>(`/api/admin/agent-keys/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  listAuditLogs(params?: { actorType?: string; status?: string }): Promise<{ logs: AuditLogRecord[] }> {
    const sp = new URLSearchParams();
    if (params?.actorType) sp.set("actorType", params.actorType);
    if (params?.status) sp.set("status", params.status);
    return requestJson<{ logs: AuditLogRecord[] }>(`/api/admin/audit-logs?${sp.toString()}`);
  },
};
