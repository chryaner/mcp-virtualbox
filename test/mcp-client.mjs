// A minimal MCP client over stdio for the smoke and end-to-end tests: start
// the built server the way a real client does and speak JSON-RPC to it.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function startServer({ env = {}, requestTimeoutMs = 10_000 } = {}) {
  const proc = spawn(process.execPath, [join(root, "dist", "index.js")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...env },
  });

  const pending = new Map();
  let buffer = "";
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });

  let nextId = 0;
  function request(method, params, timeoutMs = requestTimeoutMs) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no answer to ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  const init = await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mcp-virtualbox-tests", version: "0" },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  return {
    serverInfo: init.serverInfo,
    request,
    // The raw tool result: content plus isError.
    call: (name, args = {}, timeoutMs = 120_000) => request("tools/call", { name, arguments: args }, timeoutMs),
    close: () => proc.kill(),
  };
}

// The text of a tool result, all text blocks joined.
export function textOf(result) {
  return (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}
