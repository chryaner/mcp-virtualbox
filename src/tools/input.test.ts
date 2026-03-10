import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../vbox.js", () => ({
  vboxManage: vi.fn(),
  formatError: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { vboxManage } from "../vbox.js";
import { registerInputTools } from "./input.js";

const mockVboxManage = vi.mocked(vboxManage);

let toolHandlers: Map<string, Function>;

beforeEach(() => {
  vi.clearAllMocks();
  const server = new McpServer({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } });
  toolHandlers = new Map();
  // @ts-ignore
  server.tool = (...args: unknown[]) => {
    toolHandlers.set(args[0] as string, args[args.length - 1] as Function);
  };
  registerInputTools(server);
});

function callTool(name: string, params: Record<string, unknown> = {}) {
  const handler = toolHandlers.get(name);
  if (!handler) throw new Error(`Tool ${name} not registered`);
  return handler(params);
}

describe("vm_keyboard_scancode", () => {
  it("sends scancodes for a named key", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_keyboard_scancode", {
      vm: "TestVM", keys: "enter", count: 1, delayMs: 50,
    });
    expect(mockVboxManage).toHaveBeenCalledWith("controlvm", "TestVM", "keyboardputscancode", "1c", "9c");
    expect(result.content[0].text).toContain("enter");
  });

  it("sends key combo multiple times", async () => {
    mockVboxManage.mockResolvedValue("");
    await callTool("vm_keyboard_scancode", {
      vm: "TestVM", keys: "tab", count: 3, delayMs: 0,
    });
    expect(mockVboxManage).toHaveBeenCalledTimes(3);
  });

  it("returns error for unknown key", async () => {
    const result = await callTool("vm_keyboard_scancode", {
      vm: "TestVM", keys: "nonexistent", count: 1, delayMs: 50,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Available keys");
  });
});

describe("vm_keyboard_type", () => {
  it("types text in chunks", async () => {
    mockVboxManage.mockResolvedValue("");
    const longText = "a".repeat(150);
    await callTool("vm_keyboard_type", { vm: "TestVM", text: longText });
    // 150 chars / 64 chunk size = 3 calls
    expect(mockVboxManage).toHaveBeenCalledTimes(3);
    expect(mockVboxManage).toHaveBeenCalledWith("controlvm", "TestVM", "keyboardputstring", "a".repeat(64));
  });

  it("returns character count", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_keyboard_type", { vm: "TestVM", text: "hello" });
    expect(result.content[0].text).toContain("5 characters");
  });
});
