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

  it("sends named keypad keys", async () => {
    mockVboxManage.mockResolvedValue("");
    await callTool("vm_keyboard_scancode", {
      vm: "TestVM", keys: "kp_1", count: 1, delayMs: 50,
    });
    expect(mockVboxManage).toHaveBeenCalledWith("controlvm", "TestVM", "keyboardputscancode", "4f", "cf");
  });

  it("sends raw scancode bytes verbatim", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_keyboard_scancode", {
      vm: "TestVM", raw: "4f cf", count: 1, delayMs: 50,
    });
    expect(mockVboxManage).toHaveBeenCalledWith("controlvm", "TestVM", "keyboardputscancode", "4f", "cf");
    expect(result.content[0].text).toContain("raw");
  });

  it("normalizes and pads raw hex bytes", async () => {
    mockVboxManage.mockResolvedValue("");
    await callTool("vm_keyboard_scancode", {
      vm: "TestVM", raw: "E0  1C", count: 1, delayMs: 50,
    });
    expect(mockVboxManage).toHaveBeenCalledWith("controlvm", "TestVM", "keyboardputscancode", "e0", "1c");
  });

  it("raw takes precedence over keys", async () => {
    mockVboxManage.mockResolvedValue("");
    await callTool("vm_keyboard_scancode", {
      vm: "TestVM", keys: "enter", raw: "4f cf", count: 1, delayMs: 50,
    });
    expect(mockVboxManage).toHaveBeenCalledWith("controlvm", "TestVM", "keyboardputscancode", "4f", "cf");
  });

  it("returns error for invalid raw bytes", async () => {
    const result = await callTool("vm_keyboard_scancode", {
      vm: "TestVM", raw: "4f zz", count: 1, delayMs: 50,
    });
    expect(result.isError).toBe(true);
    expect(mockVboxManage).not.toHaveBeenCalled();
  });

  it("returns error when neither keys nor raw provided", async () => {
    const result = await callTool("vm_keyboard_scancode", {
      vm: "TestVM", count: 1, delayMs: 50,
    });
    expect(result.isError).toBe(true);
    expect(mockVboxManage).not.toHaveBeenCalled();
  });
});

describe("vm_keyboard_type", () => {
  it("types text in chunks of the given size", async () => {
    mockVboxManage.mockResolvedValue("");
    const longText = "a".repeat(150);
    await callTool("vm_keyboard_type", { vm: "TestVM", text: longText, chunkSize: 50, delayMs: 0 });
    // 150 chars / 50 chunk size = 3 calls
    expect(mockVboxManage).toHaveBeenCalledTimes(3);
    expect(mockVboxManage).toHaveBeenCalledWith("controlvm", "TestVM", "keyboardputstring", "a".repeat(50));
  });

  it("sends the full string without dropping characters", async () => {
    mockVboxManage.mockResolvedValue("");
    // Distinct chars so a dropped/duplicated chunk is detectable on reassembly.
    const text = Array.from({ length: 333 }, (_, i) => String.fromCharCode(33 + (i % 90))).join("");
    await callTool("vm_keyboard_type", { vm: "TestVM", text, chunkSize: 50, delayMs: 0 });
    const sent = mockVboxManage.mock.calls.map(c => c[3]).join("");
    expect(sent).toBe(text);
  });

  it("delays between chunks but not after the last", async () => {
    vi.useFakeTimers();
    try {
      mockVboxManage.mockResolvedValue("");
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const promise = callTool("vm_keyboard_type", { vm: "TestVM", text: "a".repeat(150), chunkSize: 50, delayMs: 30 });
      await vi.runAllTimersAsync();
      await promise;
      // 3 chunks → 2 inter-chunk delays
      expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns character count", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_keyboard_type", { vm: "TestVM", text: "hello", chunkSize: 50, delayMs: 0 });
    expect(result.content[0].text).toContain("5 characters");
  });
});
