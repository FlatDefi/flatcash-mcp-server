#!/usr/bin/env node
/**
 * @flatcash/mcp-server — Local stdio MCP proxy for flat.cash
 *
 * This server exposes all flat.cash MCP tools over stdio transport,
 * allowing Claude Desktop, Cursor, and any MCP-compatible client to
 * interact with the FLAT Protocol.
 *
 * Usage:
 *   FLATCASH_API_KEY=fak_live_xxx npx @flatcash/mcp-server
 *
 * Or in Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "flatcash": {
 *         "command": "npx",
 *         "args": ["@flatcash/mcp-server"],
 *         "env": { "FLATCASH_API_KEY": "fak_live_xxx" }
 *       }
 *     }
 *   }
 *
 * If no API key is set, the server will auto-register a new agent
 * on first use and print the key to stderr for you to save.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const FLATCASH_MCP_URL = process.env.FLATCASH_MCP_URL || "https://flat.cash/api/mcp";
const FLATCASH_REGISTER_URL = process.env.FLATCASH_REGISTER_URL || "https://flat.cash/api/agents/register";

let apiKey = process.env.FLATCASH_API_KEY || "";

// ─── Auto-registration ──────────────────────────────────────────────
async function ensureApiKey(): Promise<string> {
  if (apiKey) return apiKey;

  process.stderr.write("[flatcash-mcp] No API key found. Auto-registering a new agent...\n");

  const res = await fetch(FLATCASH_REGISTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: `mcp-${Date.now()}` }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Registration failed (${res.status}): ${err}`);
  }

  const data = await res.json() as {
    key: { apiKey: string };
    agent: { username: string };
  };

  apiKey = data.key.apiKey;

  process.stderr.write(`[flatcash-mcp] ✓ Registered as: ${data.agent.username}\n`);
  process.stderr.write(`[flatcash-mcp] ✓ API Key: ${apiKey}\n`);
  process.stderr.write(`[flatcash-mcp] ⚠ Save this key! Set FLATCASH_API_KEY env var for future sessions.\n`);
  process.stderr.write(`[flatcash-mcp] Scopes: read, earn (can browse tasks and earn FLAT)\n`);
  process.stderr.write(`[flatcash-mcp] To unlock pay/trade scopes, fund the account and upgrade at flat.cash/agents\n\n`);

  return apiKey;
}

// ─── JSON-RPC call to remote MCP ────────────────────────────────────
let jsonRpcId = 1;

async function remoteCall(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const key = await ensureApiKey();

  const body = {
    jsonrpc: "2.0",
    id: jsonRpcId++,
    method,
    params: params || {},
  };

  const res = await fetch(FLATCASH_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Remote MCP error (${res.status}): ${text}`);
  }

  const json = await res.json() as { result?: unknown; error?: { message: string } };
  if (json.error) {
    throw new Error(`Remote MCP error: ${json.error.message}`);
  }
  return json.result;
}

// ─── Server setup ───────────────────────────────────────────────────
const server = new Server(
  { name: "flatcash-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// Proxy tools/list
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const result = await remoteCall("tools/list") as { tools: unknown[] };
  return result;
});

// Proxy tools/call
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const result = await remoteCall("tools/call", {
    name: req.params.name,
    arguments: req.params.arguments,
  });
  return result as { content: Array<{ type: string; text: string }>; isError?: boolean };
});

// ─── Start ──────────────────────────────────────────────────────────
async function main() {
  // Validate key early (or auto-register)
  await ensureApiKey();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[flatcash-mcp] Server running on stdio. Connected to flat.cash.\n");
}

main().catch((err) => {
  process.stderr.write(`[flatcash-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
