import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../vbox.js", () => ({
  vboxManage: vi.fn(),
  parseMachineReadable: vi.fn(),
  formatError: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  unlink: vi.fn(),
}));

import { vboxManage, parseMachineReadable } from "../vbox.js";
import { readFile, unlink } from "node:fs/promises";
import { registerDisplayTools } from "./display.js";

const mockVboxManage = vi.mocked(vboxManage);
const mockParseMachineReadable = vi.mocked(parseMachineReadable);
const mockReadFile = vi.mocked(readFile);
const mockUnlink = vi.mocked(unlink);

let toolHandlers: Map<string, Function>;

beforeEach(() => {
  vi.clearAllMocks();
  const server = new McpServer({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } });
  toolHandlers = new Map();
  // @ts-ignore
  server.tool = (...args: unknown[]) => {
    toolHandlers.set(args[0] as string, args[args.length - 1] as Function);
  };
  registerDisplayTools(server);
});

function callTool(name: string, params: Record<string, unknown> = {}) {
  const handler = toolHandlers.get(name);
  if (!handler) throw new Error(`Tool ${name} not registered`);
  return handler(params);
}

describe("vm_screenshot", () => {
  it("returns base64 PNG image", async () => {
    mockVboxManage.mockResolvedValue("");
    const fakeImage = Buffer.from("fake-png-data");
    mockReadFile.mockResolvedValue(fakeImage);
    mockUnlink.mockResolvedValue(undefined);

    const result = await callTool("vm_screenshot", { vm: "TestVM" });
    expect(result.content[0].type).toBe("image");
    expect(result.content[0].mimeType).toBe("image/png");
    expect(result.content[0].data).toBe(fakeImage.toString("base64"));

    // Verify screenshotpng was called
    expect(mockVboxManage).toHaveBeenCalledWith("controlvm", "TestVM", "screenshotpng", expect.any(String));
    // Verify temp file is cleaned up
    expect(mockUnlink).toHaveBeenCalled();
  });
});

describe("vm_screen_info", () => {
  it("parses VideoMode from showvminfo", async () => {
    mockVboxManage.mockResolvedValue('VideoMode="1024,768,32"@0,0 1\nvram=128\ngraphicscontroller="vboxsvga"\nmonitorcount=1\n');
    mockParseMachineReadable.mockReturnValue({
      VideoMode: '"1024,768,32"@0,0 1',
      vram: "128",
      graphicscontroller: "vboxsvga",
      monitorcount: "1",
    });

    const result = await callTool("vm_screen_info", { vm: "TestVM" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.width).toBe("1024");
    expect(parsed.height).toBe("768");
    expect(parsed.bpp).toBe("32");
    expect(parsed.vram).toBe("128");
    expect(parsed.graphicsController).toBe("vboxsvga");
    expect(parsed.monitors).toBe("1");
  });

  it("returns unknown when VideoMode not available", async () => {
    mockVboxManage.mockResolvedValue('vram=128\n');
    mockParseMachineReadable.mockReturnValue({ vram: "128" });

    const result = await callTool("vm_screen_info", { vm: "TestVM" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.width).toBe("unknown");
    expect(parsed.height).toBe("unknown");
  });
});

describe("vm_screenshot - error handling", () => {
  it("propagates error when VM is not running", async () => {
    mockVboxManage.mockRejectedValue(new Error("Machine is not running"));
    await expect(callTool("vm_screenshot", { vm: "TestVM" })).rejects.toThrow("Machine is not running");
  });
});
