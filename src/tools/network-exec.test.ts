import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../vbox.js", () => ({
  vboxManage: vi.fn(),
  parseMachineReadable: vi.fn(),
  formatError: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
}));

const { EventEmitter } = require("node:events");

let lastMockConn: any;
vi.mock("ssh2", () => {
  return {
    Client: function MockSSHClient(this: any) {
      const conn = new EventEmitter();
      conn.connect = function(..._args: any[]) {
        // Defer ready/error emission so the test can set up .on() handlers first
        return conn;
      };
      conn.exec = vi.fn();
      conn.end = vi.fn();
      lastMockConn = conn;
      return conn;
    },
  };
});

import { vboxManage, parseMachineReadable } from "../vbox.js";
import { registerNetworkExecTools } from "./network-exec.js";

const mockVboxManage = vi.mocked(vboxManage);
const mockParseMachineReadable = vi.mocked(parseMachineReadable);

let toolHandlers: Map<string, Function>;

beforeEach(() => {
  vi.clearAllMocks();
  const server = new McpServer({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } });
  toolHandlers = new Map();
  // @ts-ignore
  server.tool = (...args: unknown[]) => {
    toolHandlers.set(args[0] as string, args[args.length - 1] as Function);
  };
  registerNetworkExecTools(server);
});

function callTool(name: string, params: Record<string, unknown> = {}) {
  const handler = toolHandlers.get(name);
  if (!handler) throw new Error(`Tool ${name} not registered`);
  return handler(params);
}

describe("vm_get_guest_ip", () => {
  it("returns IPs from guest properties", async () => {
    mockVboxManage.mockResolvedValue(
      "Name: /VirtualBox/GuestInfo/Net/0/V4/IP, value: 10.0.2.15, timestamp: 123\n" +
      "Name: /VirtualBox/GuestInfo/Net/1/V4/IP, value: 192.168.56.101, timestamp: 456\n",
    );
    const result = await callTool("vm_get_guest_ip", { vm: "TestVM" });
    const ips = JSON.parse(result.content[0].text);
    expect(ips).toEqual(["10.0.2.15", "192.168.56.101"]);
  });

  it("filters out 0.0.0.0", async () => {
    mockVboxManage.mockResolvedValue(
      "Name: /VirtualBox/GuestInfo/Net/0/V4/IP, value: 0.0.0.0, timestamp: 123\n",
    );
    const result = await callTool("vm_get_guest_ip", { vm: "TestVM" });
    expect(result.content[0].text).toContain("No guest IP found");
  });

  it("handles no Guest Additions", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_get_guest_ip", { vm: "TestVM" });
    expect(result.content[0].text).toContain("No guest IP found");
  });

  it("handles errors gracefully", async () => {
    mockVboxManage.mockRejectedValue(new Error("VM not found"));
    const result = await callTool("vm_get_guest_ip", { vm: "TestVM" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to get guest IP");
  });
});

describe("vm_wait_for_guest_additions", () => {
  it("returns when Guest Additions run level >= 2", async () => {
    mockVboxManage.mockResolvedValue('GuestAdditionsRunLevel=2\n');
    mockParseMachineReadable.mockReturnValue({ GuestAdditionsRunLevel: "2" });

    const result = await callTool("vm_wait_for_guest_additions", {
      vm: "TestVM", timeoutMs: 5000, pollIntervalMs: 100,
    });
    expect(result.content[0].text).toContain("Guest Additions running");
  });

  it("times out when Guest Additions not running", async () => {
    mockVboxManage.mockResolvedValue('GuestAdditionsRunLevel=0\n');
    mockParseMachineReadable.mockReturnValue({ GuestAdditionsRunLevel: "0" });

    const result = await callTool("vm_wait_for_guest_additions", {
      vm: "TestVM", timeoutMs: 300, pollIntervalMs: 100,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Timeout");
  });
});

describe("vm_add_nat_port_forward", () => {
  it("uses modifyvm when VM is powered off", async () => {
    mockVboxManage.mockResolvedValue('VMState=poweroff\n');
    mockParseMachineReadable.mockReturnValue({ VMState: "poweroff" });

    await callTool("vm_add_nat_port_forward", {
      vm: "TestVM", name: "ssh", protocol: "tcp", hostPort: 2222, guestPort: 22, adapter: 1,
    });

    expect(mockVboxManage).toHaveBeenNthCalledWith(1, "showvminfo", "TestVM", "--machinereadable");
    expect(mockVboxManage).toHaveBeenNthCalledWith(2, "modifyvm", "TestVM", "--natpf1", "ssh,tcp,,2222,,22");
  });

  it("uses controlvm when VM is running", async () => {
    mockVboxManage.mockResolvedValue('VMState=running\n');
    mockParseMachineReadable.mockReturnValue({ VMState: "running" });

    await callTool("vm_add_nat_port_forward", {
      vm: "TestVM", name: "ssh", protocol: "tcp", hostPort: 2222, guestPort: 22, adapter: 1,
    });

    expect(mockVboxManage).toHaveBeenNthCalledWith(2, "controlvm", "TestVM", "natpf1", "ssh,tcp,,2222,,22");
  });

  it("supports UDP protocol", async () => {
    mockVboxManage.mockResolvedValue("");
    mockParseMachineReadable.mockReturnValue({ VMState: "poweroff" });

    const result = await callTool("vm_add_nat_port_forward", {
      vm: "TestVM", name: "dns", protocol: "udp", hostPort: 5353, guestPort: 53, adapter: 1,
    });
    expect(mockVboxManage).toHaveBeenNthCalledWith(2, "modifyvm", "TestVM", "--natpf1", "dns,udp,,5353,,53");
    expect(result.content[0].text).toContain("udp");
  });
});

describe("vm_wait_for_network", () => {
  it("returns when guest has valid IP", async () => {
    mockVboxManage.mockResolvedValue(
      "Name: /VirtualBox/GuestInfo/Net/0/V4/IP, value: 10.0.2.15, timestamp: 123\n",
    );
    const result = await callTool("vm_wait_for_network", {
      vm: "TestVM", timeoutMs: 5000, pollIntervalMs: 100,
    });
    expect(result.content[0].text).toContain("Network ready");
    expect(result.content[0].text).toContain("10.0.2.15");
  });

  it("skips 0.0.0.0 and keeps polling", async () => {
    mockVboxManage
      .mockResolvedValueOnce("Name: /VirtualBox/GuestInfo/Net/0/V4/IP, value: 0.0.0.0, timestamp: 1\n")
      .mockResolvedValueOnce("Name: /VirtualBox/GuestInfo/Net/0/V4/IP, value: 10.0.2.15, timestamp: 2\n");

    const result = await callTool("vm_wait_for_network", {
      vm: "TestVM", timeoutMs: 5000, pollIntervalMs: 100,
    });
    expect(result.content[0].text).toContain("10.0.2.15");
  });

  it("times out when no IP appears", async () => {
    mockVboxManage.mockResolvedValue("");
    const result = await callTool("vm_wait_for_network", {
      vm: "TestVM", timeoutMs: 300, pollIntervalMs: 100,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Timeout");
  });
});

describe("vm_exec_ssh", () => {
  it("returns output on successful command", async () => {
    const promise = callTool("vm_exec_ssh", {
      host: "127.0.0.1", port: 2222, username: "user", password: "pass",
      command: "echo hello", timeoutMs: 5000,
    });

    const conn = lastMockConn;
    conn.exec.mockImplementation((_cmd: string, cb: Function) => {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      cb(null, stream);
      stream.emit("data", Buffer.from("hello world\n"));
      stream.emit("close", 0);
    });
    conn.emit("ready");

    const result = await promise;
    expect(result.content[0].text).toContain("Exit code: 0");
    expect(result.content[0].text).toContain("hello world");
  });

  it("returns error on connection failure", async () => {
    const promise = callTool("vm_exec_ssh", {
      host: "127.0.0.1", port: 2222, username: "user", password: "pass",
      command: "ls", timeoutMs: 5000,
    });

    lastMockConn.emit("error", new Error("Connection refused"));

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Connection refused");
  });
});
