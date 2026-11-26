#!/usr/bin/env node
// Starts the built server the way an MCP client does and talks to it over
// stdio: the unit tests exercise the tools with VBoxManage mocked, and none of
// them proves that dist/index.js starts, answers the handshake and lists its
// tools. This does, and it needs no VirtualBox.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const EXPECTED_TOOLS = 30;

const server = spawn(process.execPath, [join(root, "dist", "index.js")], {
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map();
let buffer = "";
server.stdout.on("data", (chunk) => {
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
function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to ${method} within 10s`)), 10_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const init = await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  check(init.serverInfo.name === "mcp-virtualbox", `server calls itself ${init.serverInfo.name}`);
  check(init.serverInfo.version === pkg.version, `server reports ${init.serverInfo.version}, package.json says ${pkg.version}`);
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const { tools } = await request("tools/list", {});
  check(tools.length === EXPECTED_TOOLS, `expected ${EXPECTED_TOOLS} tools, the server lists ${tools.length}`);
  for (const tool of tools) {
    check(/^vm_[a-z_]+$/.test(tool.name), `tool name ${tool.name} is not vm_snake_case`);
    check(tool.description, `${tool.name} has no description`);
    check(tool.inputSchema?.type === "object", `${tool.name} has no object input schema`);
    for (const [name, prop] of Object.entries(tool.inputSchema.properties ?? {})) {
      check(prop.description, `${tool.name}.${name} has no description`);
    }
  }

  // A tool that needs no VirtualBox, called for real.
  const guide = await request("tools/call", { name: "vm_install_guide", arguments: { os: "ubuntu" } });
  check(!guide.isError && guide.content?.[0]?.text?.length > 100, "vm_install_guide returned no guide");

  console.log(`ok: mcp-virtualbox ${pkg.version} on node ${process.version}, ${tools.length} tools`);
  server.kill();
} catch (err) {
  console.error(`smoke test failed: ${err.message}`);
  server.kill();
  process.exit(1);
}
