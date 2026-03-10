import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Mock vbox module
vi.mock("../vbox.js", () => ({
  vboxManage: vi.fn(),
  parseVMList: vi.fn(),
  parseMachineReadable: vi.fn(),
  formatError: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
}));

import { vboxManage, parseVMList, parseMachineReadable } from "../vbox.js";
import { registerLifecycleTools } from "./lifecycle.js";

const mockVboxManage = vi.mocked(vboxManage);
const mockParseVMList = vi.mocked(parseVMList);
const mockParseMachineReadable = vi.mocked(parseMachineReadable);

let server: McpServer;
let toolHandlers: Map<string, Function>;

beforeEach(() => {
  vi.clearAllMocks();
  server = new McpServer({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } });
  toolHandlers = new Map();
  const origTool = server.tool.bind(server);
  // @ts-ignore
  server.tool = (...args: unknown[]) => {
    const toolName = args[0] as string;
    const handler = args[args.length - 1] as Function;
    toolHandlers.set(toolName, handler);
  };
  registerLifecycleTools(server);
});

function callTool(name: string, params: Record<string, unknown> = {}) {
  const handler = toolHandlers.get(name);
  if (!handler) throw new Error(`Tool ${name} not registered`);
  return handler(params);
}

describe("vm_list", () => {
  it("returns VMs with running state", async () => {
    mockVboxManage
      .mockResolvedValueOnce('"VM1" {uuid1}\n"VM2" {uuid2}\n')
      .mockResolvedValueOnce('"VM1" {uuid1}\n');
    mockParseVMList
      .mockReturnValueOnce([{ name: "VM1", uuid: "uuid1" }, { name: "VM2", uuid: "uuid2" }])
      .mockReturnValueOnce([{ name: "VM1", uuid: "uuid1" }]);

    const result = await callTool("vm_list");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([
      { name: "VM1", uuid: "uuid1", state: "running" },
      { name: "VM2", uuid: "uuid2", state: "poweroff" },
    ]);
  });

  it("returns empty array when no VMs", async () => {
    mockVboxManage.mockResolvedValue("");
    mockParseVMList.mockReturnValue([]);

    const result = await callTool("vm_list");
    expect(JSON.parse(result.content[0].text)).toEqual([]);
  });
});

describe("vm_info", () => {
  it("returns parsed VM info", async () => {
    mockVboxManage.mockResolvedValue('name="TestVM"\nmemory=4096\n');
    mockParseMachineReadable.mockReturnValue({ name: "TestVM", memory: "4096" });

    const result = await callTool("vm_info", { vm: "TestVM" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ name: "TestVM", memory: "4096" });
  });
});

describe("vm_create", () => {
  it("creates legacy OS VM with IDE controller", async () => {
    mockVboxManage.mockResolvedValue("");
    mockParseMachineReadable.mockReturnValue({ CfgFile: "D:\\TestXP\\TestXP.vbox" });

    const result = await callTool("vm_create", { name: "TestXP", osTypeId: "WindowsXP" });
    expect(result.content[0].text).toContain("IDE only (legacy OS");
    expect(result.content[0].text).toContain("RAM: 512MB");

    // Verify IDE controller was created (not SATA)
    const calls = mockVboxManage.mock.calls.map(c => c.join(" "));
    expect(calls.some(c => c.includes("storagectl") && c.includes("IDE") && c.includes("--add") && c.includes("ide"))).toBe(true);
    expect(calls.some(c => c.includes("SATA"))).toBe(false);
  });

  it("creates modern OS VM with SATA + IDE controllers", async () => {
    mockVboxManage.mockResolvedValue("");
    mockParseMachineReadable.mockReturnValue({ CfgFile: "D:\\Win10\\Win10.vbox" });

    const result = await callTool("vm_create", { name: "Win10", osTypeId: "Windows10_64" });
    expect(result.content[0].text).toContain("SATA for HDD");
    expect(result.content[0].text).toContain("RAM: 4096MB");

    const calls = mockVboxManage.mock.calls.map(c => c.join(" "));
    expect(calls.some(c => c.includes("SATA") && c.includes("IntelAhci"))).toBe(true);
  });

  it("uses custom memory/cpu/disk when provided", async () => {
    mockVboxManage.mockResolvedValue("");
    mockParseMachineReadable.mockReturnValue({ CfgFile: "D:\\VM\\VM.vbox" });

    const result = await callTool("vm_create", {
      name: "Custom", osTypeId: "Ubuntu_64", memoryMB: 8192, cpus: 4, diskSizeMB: 100000,
    });
    expect(result.content[0].text).toContain("RAM: 8192MB");
    expect(result.content[0].text).toContain("CPUs: 4");
    expect(result.content[0].text).toContain("Disk: 100000MB");
  });

  it("uses basedir when provided", async () => {
    mockVboxManage.mockResolvedValue("");
    mockParseMachineReadable.mockReturnValue({ CfgFile: "E:\\VMs\\Test\\Test.vbox" });

    await callTool("vm_create", { name: "Test", osTypeId: "Ubuntu_64", basedir: "E:\\VMs" });
    const createCall = mockVboxManage.mock.calls.find(c => c[0] === "createvm");
    expect(createCall).toContain("--basefolder");
    expect(createCall).toContain("E:\\VMs");
  });

  it("applies correct defaults for DOS", async () => {
    mockVboxManage.mockResolvedValue("");
    mockParseMachineReadable.mockReturnValue({ CfgFile: "D:\\DOS\\DOS.vbox" });

    const result = await callTool("vm_create", { name: "DOS", osTypeId: "DOS" });
    expect(result.content[0].text).toContain("RAM: 64MB");
    expect(result.content[0].text).toContain("Disk: 2000MB");
  });
});

describe("vm_start", () => {
  it("starts VM headless by default", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_start", { vm: "TestVM", headless: true });
    expect(mockVboxManage).toHaveBeenCalledWith("startvm", "TestVM", "--type", "headless");
    expect(result.content[0].text).toContain("headless");
  });

  it("starts VM with GUI", async () => {
    mockVboxManage.mockResolvedValue("");
    await callTool("vm_start", { vm: "TestVM", headless: false });
    expect(mockVboxManage).toHaveBeenCalledWith("startvm", "TestVM", "--type", "gui");
  });
});

describe("vm_stop", () => {
  it("stops VM with poweroff by default", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_stop", { vm: "TestVM", method: "poweroff" });
    expect(mockVboxManage).toHaveBeenCalledWith("controlvm", "TestVM", "poweroff");
    expect(result.content[0].text).toContain("poweroff");
  });

  it("stops VM with acpipowerbutton", async () => {
    mockVboxManage.mockResolvedValue("");
    await callTool("vm_stop", { vm: "TestVM", method: "acpipowerbutton" });
    expect(mockVboxManage).toHaveBeenCalledWith("controlvm", "TestVM", "acpipowerbutton");
  });
});

describe("vm_delete", () => {
  it("deletes VM with files by default", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_delete", { vm: "TestVM", deleteFiles: true });
    expect(mockVboxManage).toHaveBeenCalledWith("unregistervm", "TestVM", "--delete");
    expect(result.content[0].text).toContain("with all files");
  });

  it("unregisters VM without deleting files", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_delete", { vm: "TestVM", deleteFiles: false });
    expect(mockVboxManage).toHaveBeenCalledWith("unregistervm", "TestVM");
    expect(result.content[0].text).toContain("unregistered only");
  });
});

describe("vm_pause / vm_resume / vm_reset", () => {
  it("pauses VM", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_pause", { vm: "TestVM" });
    expect(mockVboxManage).toHaveBeenCalledWith("controlvm", "TestVM", "pause");
    expect(result.content[0].text).toContain("paused");
  });

  it("resumes VM", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_resume", { vm: "TestVM" });
    expect(mockVboxManage).toHaveBeenCalledWith("controlvm", "TestVM", "resume");
    expect(result.content[0].text).toContain("resumed");
  });

  it("resets VM", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_reset", { vm: "TestVM" });
    expect(mockVboxManage).toHaveBeenCalledWith("controlvm", "TestVM", "reset");
    expect(result.content[0].text).toContain("reset");
  });
});

describe("vm_snapshot", () => {
  it("takes a snapshot", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_snapshot", { vm: "TestVM", action: "take", snapshotName: "snap1" });
    expect(mockVboxManage).toHaveBeenCalledWith("snapshot", "TestVM", "take", "snap1");
    expect(result.content[0].text).toContain("take completed");
  });

  it("restores a snapshot", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_snapshot", { vm: "TestVM", action: "restore", snapshotName: "snap1" });
    expect(mockVboxManage).toHaveBeenCalledWith("snapshot", "TestVM", "restore", "snap1");
  });

  it("deletes a snapshot", async () => {
    mockVboxManage.mockResolvedValue("");
    await callTool("vm_snapshot", { vm: "TestVM", action: "delete", snapshotName: "snap1" });
    expect(mockVboxManage).toHaveBeenCalledWith("snapshot", "TestVM", "delete", "snap1");
  });

  it("lists snapshots", async () => {
    mockVboxManage.mockResolvedValue('SnapshotName="snap1"\nSnapshotUUID="uuid1"\n');
    const result = await callTool("vm_snapshot", { vm: "TestVM", action: "list" });
    expect(result.content[0].text).toContain("snap1");
  });

  it("handles no snapshots gracefully", async () => {
    mockVboxManage.mockRejectedValue(new Error("does not have any snapshots"));
    const result = await callTool("vm_snapshot", { vm: "TestVM", action: "list" });
    expect(result.content[0].text).toBe("No snapshots.");
  });

  it("requires snapshotName for take/restore/delete", async () => {
    const result = await callTool("vm_snapshot", { vm: "TestVM", action: "take" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("snapshotName is required");
  });
});

describe("vm_modify", () => {
  it("passes args to modifyvm", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_modify", { vm: "TestVM", args: ["--memory", "4096"] });
    expect(mockVboxManage).toHaveBeenCalledWith("modifyvm", "TestVM", "--memory", "4096");
    expect(result.content[0].text).toContain("--memory 4096");
  });
});

describe("vm_shared_folder_add", () => {
  it("adds persistent shared folder", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_shared_folder_add", {
      vm: "TestVM", name: "share1", hostPath: "D:\\Share", writable: true, automount: true, transient: false,
    });
    const call = mockVboxManage.mock.calls[0];
    expect(call).toContain("sharedfolder");
    expect(call).not.toContain("--transient");
    expect(call).toContain("--automount");
    expect(result.content[0].text).toContain("read-write");
  });

  it("adds transient readonly shared folder", async () => {
    mockVboxManage.mockResolvedValue("");
    await callTool("vm_shared_folder_add", {
      vm: "TestVM", name: "share1", hostPath: "D:\\Share", transient: true, writable: false, automount: true,
    });
    const call = mockVboxManage.mock.calls[0];
    expect(call).toContain("--transient");
    expect(call).toContain("--readonly");
  });
});

describe("vm_shared_folder_remove", () => {
  it("removes shared folder", async () => {
    mockVboxManage.mockResolvedValue("");
    await callTool("vm_shared_folder_remove", { vm: "TestVM", name: "share1", transient: false });
    expect(mockVboxManage).toHaveBeenCalledWith("sharedfolder", "remove", "TestVM", "--name", "share1");
  });

  it("removes transient shared folder", async () => {
    mockVboxManage.mockResolvedValue("");
    await callTool("vm_shared_folder_remove", { vm: "TestVM", name: "share1", transient: true });
    const call = mockVboxManage.mock.calls[0];
    expect(call).toContain("--transient");
  });
});

describe("vm_attach_media", () => {
  it("attaches ISO", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_attach_media", {
      vm: "TestVM", storagectl: "IDE", port: 0, device: 0, type: "dvddrive", medium: "C:\\ISOs\\win.iso",
    });
    expect(mockVboxManage).toHaveBeenCalledWith(
      "storageattach", "TestVM", "--storagectl", "IDE", "--port", "0", "--device", "0", "--type", "dvddrive", "--medium", "C:\\ISOs\\win.iso",
    );
    expect(result.content[0].text).toContain("Attached");
  });

  it("ejects media", async () => {
    mockVboxManage.mockResolvedValue("");
    await callTool("vm_attach_media", { vm: "TestVM", storagectl: "IDE", port: 0, device: 0, type: "dvddrive", medium: "emptydrive" });
    const call = mockVboxManage.mock.calls[0];
    expect(call).toContain("emptydrive");
  });
});

describe("vm_list_ostypes", () => {
  it("parses new VBox 7.1+ format", async () => {
    mockVboxManage.mockResolvedValue(
      "Supported guest OS types:\n\nID / Description: WindowsXP -- Windows XP (32-bit)\nFamily:           Windows\n\nID / Description: Ubuntu_64 -- Ubuntu (64-bit)\nFamily:           Linux\n",
    );
    const result = await callTool("vm_list_ostypes");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([
      { id: "WindowsXP", description: "Windows XP (32-bit)" },
      { id: "Ubuntu_64", description: "Ubuntu (64-bit)" },
    ]);
  });

  it("parses old VBox format", async () => {
    mockVboxManage.mockResolvedValue("ID:          WindowsXP\nDescription: Windows XP\n\nID:          Ubuntu_64\nDescription: Ubuntu (64-bit)\n");
    const result = await callTool("vm_list_ostypes");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([
      { id: "WindowsXP", description: "Windows XP" },
      { id: "Ubuntu_64", description: "Ubuntu (64-bit)" },
    ]);
  });
});
