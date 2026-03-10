import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerKnowledgeTools } from "./knowledge.js";

let toolHandlers: Map<string, Function>;

beforeEach(() => {
  const server = new McpServer({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } });
  toolHandlers = new Map();
  // @ts-ignore
  server.tool = (...args: unknown[]) => {
    toolHandlers.set(args[0] as string, args[args.length - 1] as Function);
  };
  registerKnowledgeTools(server);
});

function callTool(name: string, params: Record<string, unknown> = {}) {
  const handler = toolHandlers.get(name);
  if (!handler) throw new Error(`Tool ${name} not registered`);
  return handler(params);
}

describe("vm_install_guide", () => {
  it("returns Windows XP guide", async () => {
    const result = await callTool("vm_install_guide", { os: "windowsxp" });
    const text = result.content[0].text;
    expect(text).toContain("Windows XP");
    expect(text).toContain("IDE");
    expect(text).toContain("BLANK passwords");
    expect(text).toContain("Installation Steps");
    expect(text).toContain("Gotchas");
    expect(text).toContain("vm_guest_exec Usage");
  });

  it("resolves aliases to the same guide", async () => {
    const r1 = await callTool("vm_install_guide", { os: "xp" });
    const r2 = await callTool("vm_install_guide", { os: "winxp" });
    const r3 = await callTool("vm_install_guide", { os: "WindowsXP" });
    expect(r1.content[0].text).toEqual(r2.content[0].text);
    expect(r1.content[0].text).toEqual(r3.content[0].text);
  });

  it("returns Windows 10 guide with SATA", async () => {
    const result = await callTool("vm_install_guide", { os: "windows10" });
    expect(result.content[0].text).toContain("Windows 10/11");
    expect(result.content[0].text).toContain("SATA");
  });

  it("returns Ubuntu guide without guestExecTips", async () => {
    const result = await callTool("vm_install_guide", { os: "ubuntu" });
    expect(result.content[0].text).toContain("Ubuntu");
    expect(result.content[0].text).toContain("SSH");
    expect(result.content[0].text).not.toContain("vm_guest_exec Usage");
  });

  it("returns helpful message for unknown OS", async () => {
    const result = await callTool("vm_install_guide", { os: "haiku" });
    expect(result.content[0].text).toContain('No guide found for "haiku"');
    expect(result.content[0].text).toContain("Available guides");
    expect(result.content[0].text).toContain("vm_list_ostypes");
  });
});
