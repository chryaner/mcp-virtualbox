import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../vbox.js", () => ({
  vboxManage: vi.fn(),
  formatError: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
}));

import { vboxManage } from "../vbox.js";
import { registerGuestControlTools } from "./guest-control.js";

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
  registerGuestControlTools(server);
});

function callTool(name: string, params: Record<string, unknown> = {}) {
  const handler = toolHandlers.get(name);
  if (!handler) throw new Error(`Tool ${name} not registered`);
  return handler(params);
}

describe("vm_guest_exec", () => {
  it("executes command with args", async () => {
    mockVboxManage.mockResolvedValue("Hello World\n");
    const result = await callTool("vm_guest_exec", {
      vm: "TestVM",
      executable: "C:\\WINDOWS\\system32\\cmd.exe",
      args: ["/c", "echo", "Hello"],
      username: "admin",
      password: "pass123",
      timeoutMs: 30000,
    });
    expect(result.content[0].text).toBe("Hello World\n");

    const call = mockVboxManage.mock.calls[0];
    expect(call).toContain("guestcontrol");
    expect(call).toContain("--exe");
    expect(call).toContain("--username");
    expect(call).toContain("admin");
    expect(call).toContain("--password");
    expect(call).toContain("pass123");
    expect(call).toContain("--");
    expect(call).toContain("/c");
    expect(call).toContain("echo");
  });

  it("omits --password when password is empty", async () => {
    mockVboxManage.mockResolvedValue("output");
    await callTool("vm_guest_exec", {
      vm: "TestVM",
      executable: "/bin/ls",
      args: [],
      username: "user",
      password: "",
      timeoutMs: 30000,
    });
    const call = mockVboxManage.mock.calls[0];
    expect(call).not.toContain("--password");
  });

  it("handles no output", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_guest_exec", {
      vm: "TestVM", executable: "/bin/true", args: [], username: "user", password: "p", timeoutMs: 5000,
    });
    expect(result.content[0].text).toBe("(no output)");
  });

  it("handles errors", async () => {
    mockVboxManage.mockRejectedValue(new Error("Guest Additions not running"));
    const result = await callTool("vm_guest_exec", {
      vm: "TestVM", executable: "/bin/ls", args: [], username: "user", password: "p", timeoutMs: 5000,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Guest exec failed");
  });

  it("does not pass -- when args is empty", async () => {
    mockVboxManage.mockResolvedValue("ok");
    await callTool("vm_guest_exec", {
      vm: "TestVM", executable: "/bin/true", args: [], username: "user", password: "p", timeoutMs: 5000,
    });
    const call = mockVboxManage.mock.calls[0];
    expect(call).not.toContain("--");
  });
});

describe("vm_guest_copy_to", () => {
  it("copies file from host to guest", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_guest_copy_to", {
      vm: "TestVM", hostPath: "C:\\file.txt", guestPath: "C:\\dest\\",
      username: "admin", password: "pass",
    });
    expect(mockVboxManage).toHaveBeenCalledWith(
      "guestcontrol", "TestVM", "copyto",
      "--target-directory", "C:\\dest\\",
      "--username", "admin",
      "--password", "pass",
      "C:\\file.txt",
    );
    expect(result.content[0].text).toContain("Copied");
  });
});

describe("vm_guest_copy_from", () => {
  it("copies file from guest to host", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_guest_copy_from", {
      vm: "TestVM", guestPath: "C:\\file.txt", hostPath: "D:\\dest\\",
      username: "admin", password: "pass",
    });
    expect(mockVboxManage).toHaveBeenCalledWith(
      "guestcontrol", "TestVM", "copyfrom",
      "--target-directory", "D:\\dest\\",
      "--username", "admin",
      "--password", "pass",
      "C:\\file.txt",
    );
    expect(result.content[0].text).toContain("Copied");
  });
});

// VirtualBox 7 treats a destination as a directory only when it ends in a
// separator, and refuses an existing directory named without one.
describe("copy destinations on VirtualBox 7", () => {
  const isDirectory = (dest: string) =>
    new Error(`VBoxManage guestcontrol failed: VBoxManage: error: Destination "${dest}" on the guest already exists and is a directory`);
  const target = (call: number) => {
    const args = mockVboxManage.mock.calls[call] as string[];
    return args[args.indexOf("--target-directory") + 1];
  };
  const creds = { username: "u", password: "p" };

  it("retries a guest directory with a trailing slash", async () => {
    mockVboxManage.mockRejectedValueOnce(isDirectory("/tmp")).mockResolvedValueOnce("");
    const result = await callTool("vm_guest_copy_to", { vm: "VM", hostPath: "/h/f.bin", guestPath: "/tmp", ...creds });
    expect(mockVboxManage).toHaveBeenCalledTimes(2);
    expect(target(0)).toBe("/tmp");
    expect(target(1)).toBe("/tmp/");
    expect(result.content[0].text).toContain('guest:"/tmp/"');
  });

  it("uses a backslash for a Windows guest directory", async () => {
    mockVboxManage.mockRejectedValueOnce(isDirectory("C:\\Temp")).mockResolvedValueOnce("");
    await callTool("vm_guest_copy_to", { vm: "VM", hostPath: "/h/f.bin", guestPath: "C:\\Temp", ...creds });
    expect(target(1)).toBe("C:\\Temp\\");
  });

  it("retries a host directory the same way", async () => {
    mockVboxManage.mockRejectedValueOnce(isDirectory("/home/me/out")).mockResolvedValueOnce("");
    const result = await callTool("vm_guest_copy_from", { vm: "VM", guestPath: "/tmp/f.bin", hostPath: "/home/me/out", ...creds });
    expect(target(1)).toBe("/home/me/out/");
    expect(result.content[0].text).toContain('"/home/me/out/"');
  });

  it("copies to a file name in one call", async () => {
    mockVboxManage.mockResolvedValue("");
    await callTool("vm_guest_copy_to", { vm: "VM", hostPath: "/h/f.bin", guestPath: "/tmp/renamed.bin", ...creds });
    expect(mockVboxManage).toHaveBeenCalledTimes(1);
    expect(target(0)).toBe("/tmp/renamed.bin");
  });

  it("does not retry a destination that already ends in a separator", async () => {
    mockVboxManage.mockRejectedValue(isDirectory("/tmp/"));
    await expect(callTool("vm_guest_copy_to", { vm: "VM", hostPath: "/h/f.bin", guestPath: "/tmp/", ...creds })).rejects.toThrow("is a directory");
    expect(mockVboxManage).toHaveBeenCalledTimes(1);
  });

  it("does not retry any other failure", async () => {
    mockVboxManage.mockRejectedValue(new Error("VBoxManage guestcontrol failed: The specified user was not able to logon on guest"));
    await expect(callTool("vm_guest_copy_from", { vm: "VM", guestPath: "/tmp/f", hostPath: "/out", ...creds })).rejects.toThrow("not able to logon");
    expect(mockVboxManage).toHaveBeenCalledTimes(1);
  });
});
