#!/usr/bin/env node
// Starts the built server the way an MCP client does and talks to it over
// stdio: the unit tests exercise the tools with VBoxManage mocked, and none of
// them proves that dist/index.js starts, answers the handshake and lists its
// tools. This does, and it needs no VirtualBox.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root, startServer, textOf } from "./mcp-client.mjs";

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const EXPECTED_TOOLS = 30;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

let server;
try {
  server = await startServer();
  check(server.serverInfo.name === "mcp-virtualbox", `server calls itself ${server.serverInfo.name}`);
  check(server.serverInfo.version === pkg.version, `server reports ${server.serverInfo.version}, package.json says ${pkg.version}`);

  const { tools } = await server.request("tools/list", {});
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
  const guide = await server.call("vm_install_guide", { os: "ubuntu" });
  check(!guide.isError && textOf(guide).length > 100, "vm_install_guide returned no guide");

  console.log(`ok: mcp-virtualbox ${pkg.version} on node ${process.version}, ${tools.length} tools`);
  server.close();
} catch (err) {
  console.error(`smoke test failed: ${err.message}`);
  server?.close();
  process.exit(1);
}
