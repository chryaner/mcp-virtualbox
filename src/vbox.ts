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

export function vboxManage(...args: string[]): Promise<string> {
  const command = `VBoxManage ${args.join(" ")}`;

  if (config.dryRun) {
    config.log(`[dry-run] ${command}`);
    return Promise.resolve("");
  }

  config.log(`[exec] ${command}`);

  return new Promise((resolve, reject) => {
    execFile(config.vboxManagePath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = `VBoxManage ${args[0]} failed: ${stderr || err.message}`;
        config.log(`[error] ${msg}`);
        reject(new VBoxError(args[0], stderr, msg));
      } else {
        config.log(`[ok] ${args[0]} (${stdout.length} bytes)`);
        resolve(stdout.replace(/\r\n/g, "\n"));
      }
    });
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
