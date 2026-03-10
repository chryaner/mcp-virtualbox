#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";
import { registerDisplayTools } from "./tools/display.js";
import { registerInputTools } from "./tools/input.js";
import { registerGuestControlTools } from "./tools/guest-control.js";
import { registerNetworkExecTools } from "./tools/network-exec.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const server = new McpServer({
  name: "mcp-virtualbox",
  version,
}, {
  capabilities: {
    tools: {},
  },
});

registerLifecycleTools(server);
registerDisplayTools(server);
registerInputTools(server);
registerGuestControlTools(server);
registerNetworkExecTools(server);
registerKnowledgeTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-virtualbox server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
