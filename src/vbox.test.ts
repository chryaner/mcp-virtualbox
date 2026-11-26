import { describe, it, expect } from "vitest";
import { parseMachineReadable, parseVMList, VBoxError, formatError, failureText } from "./vbox.js";

describe("parseMachineReadable", () => {
  it("parses key=value pairs", () => {
    const output = 'name="TestVM"\nUUID="abc-123"\nmemory=4096';
    const result = parseMachineReadable(output);
    expect(result).toEqual({
      name: "TestVM",
      UUID: "abc-123",
      memory: "4096",
    });
  });

  it("handles quoted keys and values", () => {
    const output = '"CfgFile"="C:\\\\VMs\\\\TestVM\\\\TestVM.vbox"';
    const result = parseMachineReadable(output);
    expect(result["CfgFile"]).toBe("C:\\VMs\\TestVM\\TestVM.vbox");
  });

  it("handles empty input", () => {
    expect(parseMachineReadable("")).toEqual({});
    expect(parseMachineReadable("\n\n")).toEqual({});
  });

  it("handles lines without equals sign", () => {
    const output = "some random line\nkey=value\nanother line";
    const result = parseMachineReadable(output);
    expect(result).toEqual({ key: "value" });
  });

  it("handles values containing equals sign", () => {
    const output = 'description="a=b=c"';
    const result = parseMachineReadable(output);
    expect(result["description"]).toBe("a=b=c");
  });

  it("handles \\r\\n line endings", () => {
    const output = "name=\"TestVM\"\r\nUUID=\"abc\"";
    // vboxManage() normalizes \r\n, but parseMachineReadable should still handle it
    const result = parseMachineReadable(output);
    expect(result["name"]).toBe("TestVM");
  });
});

describe("parseVMList", () => {
  it("parses VM list output", () => {
    const output = '"Windows XP" {abc-123}\n"Ubuntu 22.04" {def-456}\n';
    const result = parseVMList(output);
    expect(result).toEqual([
      { name: "Windows XP", uuid: "abc-123" },
      { name: "Ubuntu 22.04", uuid: "def-456" },
    ]);
  });

  it("handles empty output", () => {
    expect(parseVMList("")).toEqual([]);
  });

  it("ignores non-matching lines", () => {
    const output = 'some random line\n"TestVM" {uuid-here}\n\n';
    const result = parseVMList(output);
    expect(result).toEqual([{ name: "TestVM", uuid: "uuid-here" }]);
  });
});

describe("VBoxError", () => {
  it("extracts error code from stderr", () => {
    const err = new VBoxError("startvm", "error: code VBOX_E_OBJECT_NOT_FOUND", "VM not found");
    expect(err.code).toBe("VBOX_E_OBJECT_NOT_FOUND");
    expect(err.command).toBe("startvm");
    expect(err.message).toBe("VM not found");
    expect(err.name).toBe("VBoxError");
  });

  it("uses UNKNOWN when no code in stderr", () => {
    const err = new VBoxError("startvm", "something failed", "fail");
    expect(err.code).toBe("UNKNOWN");
  });
});

describe("formatError", () => {
  it("formats VBoxError with code", () => {
    const err = new VBoxError("startvm", "code VBOX_E_INVALID_OBJECT_STATE", "VM is locked");
    expect(formatError(err)).toBe("[VBOX_E_INVALID_OBJECT_STATE] VM is locked");
  });

  it("formats regular Error", () => {
    expect(formatError(new Error("something broke"))).toBe("something broke");
  });

  it("formats non-Error values", () => {
    expect(formatError("string error")).toBe("string error");
    expect(formatError(42)).toBe("42");
  });
});

describe("failureText", () => {
  const exit1 = { code: 1, message: "Command failed: VBoxManage guestcontrol vm run --username u --password hunter2" };

  it("prefers stderr", () => {
    expect(failureText(exit1, "partial output", "VBoxManage: error: no such VM\n")).toBe("VBoxManage: error: no such VM");
  });

  it("falls back to stdout when stderr is empty", () => {
    expect(failureText(exit1, "This machine does not have any snapshots\r\n", "")).toBe("This machine does not have any snapshots");
  });

  it("never repeats the command line, which can hold a guest password", () => {
    const text = failureText(exit1, "", "");
    expect(text).not.toContain("hunter2");
    expect(text).toBe("exit code 1, no output");
  });

  it("passes on why the process could not start", () => {
    expect(failureText({ code: "ENOENT", message: "spawn VBoxManage ENOENT" }, "", "")).toBe("spawn VBoxManage ENOENT");
  });
});
