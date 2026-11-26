import { execFile } from "node:child_process";
import { config } from "./types.js";

export class VBoxError extends Error {
  code: string;
  command: string;

  constructor(command: string, stderr: string, message: string) {
    const code = stderr.match(/code (VBOX_E_\w+)/)?.[1] || "UNKNOWN";
    super(message);
    this.name = "VBoxError";
    this.code = code;
    this.command = command;
  }
}

export function formatError(err: unknown): string {
  if (err instanceof VBoxError) {
    return `[${err.code}] ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

// What a failed VBoxManage had to say. Almost always that is on stderr, but
// some failures are reported on stdout with a non-zero exit code and nothing
// on stderr ("This machine does not have any snapshots"). Node's own message
// for a non-zero exit is never used: it is "Command failed:" followed by the
// whole command line, which for the guest control tools includes the guest
// password. A process that could not be started at all has no command output
// and an error worth passing on (ENOENT: VBoxManage is not installed).
export function failureText(err: { code?: unknown; message: string }, stdout: string, stderr: string): string {
  const said = stderr.trim() || stdout.trim();
  if (said) return said.replace(/\r\n/g, "\n");
  return typeof err.code === "number" ? `exit code ${err.code}, no output` : err.message;
}

export function vboxManage(...args: string[]): Promise<string> {
  const command = `VBoxManage ${args.join(" ")}`;

  if (config.dryRun) {
    config.log(`[dry-run] ${command}`);
    return Promise.resolve("");
  }

  config.log(`[exec] ${command}`);

  return new Promise((resolve, reject) => {
    const child = execFile(config.vboxManagePath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = `VBoxManage ${args[0]} failed: ${failureText(err, stdout, stderr)}`;
        config.log(`[error] ${msg}`);
        reject(new VBoxError(args[0], stderr, msg));
      } else {
        config.log(`[ok] ${args[0]} (${stdout.length} bytes)`);
        resolve(stdout.replace(/\r\n/g, "\n"));
      }
    });
    // VBoxManage has nothing to read from this process, and must not wait to.
    // `guestcontrol run` passes its own stdin on to the guest program: left
    // as an open pipe that never ends, it returned no output at all on a
    // Linux host with VirtualBox 7.2.22.
    child.stdin?.end();
  });
}

export function parseMachineReadable(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("=")) continue;
    const eqIdx = trimmed.indexOf("=");
    let key = trimmed.slice(0, eqIdx);
    let val = trimmed.slice(eqIdx + 1);
    key = key.replace(/^"|"$/g, "");
    val = val.replace(/^"|"$/g, "").replace(/\\\\/g, "\\");
    result[key] = val;
  }
  return result;
}

export function parseVMList(output: string): Array<{ name: string; uuid: string }> {
  const vms: Array<{ name: string; uuid: string }> = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^"(.+)"\s+\{(.+)\}$/);
    if (match) {
      vms.push({ name: match[1], uuid: match[2] });
    }
  }
  return vms;
}
