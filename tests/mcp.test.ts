/**
 * @file tests/mcp.test.ts
 * @description Tests the Streamable HTTP MCP server (`/mcp`): JSON-RPC initialization,
 * dynamic tool filtering by key scope & AI feature toggles, and end-to-end tool execution.
 */

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/worker/index";
import { createAddress, updateSettings } from "../src/worker/services/addresses";
import { createAgentKey } from "../src/worker/services/agent-keys";
import { ingestInboundEmail } from "../src/worker/services/mail";
import { ResendClient } from "../src/worker/services/resend";
import {
  buildTestEnv,
  createMockResendFetch,
  createMockWorkersAi,
  resetDatabaseAndStorage,
} from "./helpers/test-env";

async function callMcp(
  app: ReturnType<typeof createApp>,
  testEnv: ReturnType<typeof buildTestEnv>,
  bearer: string,
  payload: Record<string, unknown>,
) {
  return app.fetch(
    new Request("https://postlet.example.com/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...payload }),
    }),
    testEnv,
  );
}

describe("Streamable HTTP MCP Endpoint (/mcp)", () => {
  beforeEach(async () => {
    await resetDatabaseAndStorage();
  });

  it("initializes, scopes tools/list by key tier & AI toggles, and executes mail + AI tools", async () => {
    await createAddress(env.DB, { email: "me@mail.example.com", isDefault: true });

    const mockAi = createMockWorkersAi(() => ({
      response: JSON.stringify({
        overview: "1 unread investor thread.",
        todos: [{ title: "Reply with metrics", sender: "vc@fund.com", due_hint: "Today" }],
        reminders: [],
        fyi: [],
      }),
    }));

    const mockResend = createMockResendFetch({
      receivedEmails: {
        em_mcp_1: {
          id: "em_mcp_1",
          from: "vc@fund.com",
          to: ["me@mail.example.com"],
          subject: "Monthly metrics",
          text: "Could you share Q3 ARR?",
        },
      },
    });

    const testEnv = buildTestEnv({ AI: mockAi as unknown as Ai });
    const app = createApp({ resendFetchFn: mockResend.fetchFn });

    const resendClient = new ResendClient("re_test", mockResend.fetchFn);
    const ingested = await ingestInboundEmail(env.DB, env.ATTACHMENTS, resendClient, {
      email_id: "em_mcp_1",
      from: "vc@fund.com",
      to: ["me@mail.example.com"],
    });

    const roKey = await createAgentKey(
      env.DB,
      { name: "McpReader", scope: "read_only" },
      "https://postlet.example.com",
    );
    const rwKey = await createAgentKey(
      env.DB,
      { name: "McpWriter", scope: "read_write" },
      "https://postlet.example.com",
    );

    // 1. initialize handshake
    const initRes = await callMcp(app, testEnv, roKey.plaintextSecret, {
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(initRes.status).toBe(200);
    const initJson = (await initRes.json()) as {
      result: { serverInfo: { name: string }; protocolVersion: string };
    };
    expect(initJson.result.serverInfo.name).toBe("postlet-mcp");

    // 2. read_only with AI disabled -> only read-only non-AI tools exposed
    const listRoOff = await callMcp(app, testEnv, roKey.plaintextSecret, {
      id: 2,
      method: "tools/list",
    });
    const toolsRoOff = ((await listRoOff.json()) as { result: { tools: Array<{ name: string }> } })
      .result.tools.map((t) => t.name);
    expect(toolsRoOff).toContain("list_threads");
    expect(toolsRoOff).toContain("get_daily_summary");
    expect(toolsRoOff).not.toContain("create_draft");
    expect(toolsRoOff).not.toContain("send_email");
    expect(toolsRoOff).not.toContain("generate_daily_summary");

    // 3. Enable AI + built-in functions -> read_write key now exposes AI + send tools
    await updateSettings(env.DB, {
      aiEnabled: true,
      aiDailySummaryEnabled: true,
      aiImportantAutoReplyEnabled: true,
    });

    const listRwOn = await callMcp(app, testEnv, rwKey.plaintextSecret, {
      id: 3,
      method: "tools/list",
    });
    const toolsRwOn = ((await listRwOn.json()) as { result: { tools: Array<{ name: string }> } })
      .result.tools.map((t) => t.name);
    expect(toolsRwOn).toContain("send_email");
    expect(toolsRwOn).toContain("generate_daily_summary");
    expect(toolsRwOn).toContain("trigger_important_auto_reply");

    // 4. read_only key cannot bypass by calling send_email directly
    const deniedSend = await callMcp(app, testEnv, roKey.plaintextSecret, {
      id: 4,
      method: "tools/call",
      params: {
        name: "send_email",
        arguments: { to: ["vc@fund.com"], subject: "Sneaky", textBody: "No" },
      },
    });
    const deniedJson = (await deniedSend.json()) as { result: { isError?: boolean } };
    expect(deniedJson.result.isError).toBe(true);

    // 5. read_only key calls read_thread and generate_daily_summary
    const readCall = await callMcp(app, testEnv, roKey.plaintextSecret, {
      id: 5,
      method: "tools/call",
      params: { name: "read_thread", arguments: { threadId: ingested.threadId } },
    });
    const readJson = (await readCall.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(readJson.result.isError).toBeUndefined();
    expect(readJson.result.content[0].text).toContain("Monthly metrics");

    const digestCall = await callMcp(app, testEnv, roKey.plaintextSecret, {
      id: 6,
      method: "tools/call",
      params: { name: "generate_daily_summary", arguments: {} },
    });
    const digestJson = (await digestCall.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(digestJson.result.isError).toBeUndefined();
    expect(digestJson.result.content[0].text).toContain("Reply with metrics");
  });
});
