import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

export interface VBoxConfig {
  vboxManagePath: string;
  pythonPath: string;
  mouseHelperPath: string;
  screenshotDir: string;
  defaultTimeout: number;
  dryRun: boolean;
  log: (msg: string) => void;
}

function findVBoxManage(): string {
  if (process.env.VBOXMANAGE_PATH) return process.env.VBOXMANAGE_PATH;

  const candidates = process.platform === "win32"
    ? [
        join(process.env.PROGRAMFILES || "C:\\Program Files", "Oracle", "VirtualBox", "VBoxManage.exe"),
        join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Oracle", "VirtualBox", "VBoxManage.exe"),
        "C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe",
      ]
    : [
        "/usr/bin/VBoxManage",
        "/usr/local/bin/VBoxManage",
        "/opt/VirtualBox/VBoxManage",
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // Fallback: hope it's on PATH
  return "VBoxManage";
}

export const config: VBoxConfig = {
  vboxManagePath: findVBoxManage(),
  pythonPath: process.env.PYTHON_PATH || "python",
  mouseHelperPath: process.env.MOUSE_HELPER_PATH || join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "mouse_click.py"),
  screenshotDir: process.env.SCREENSHOT_DIR || (process.env.TEMP || "/tmp"),
  defaultTimeout: Number(process.env.DEFAULT_TIMEOUT) || 30000,
  dryRun: process.env.VBOXMANAGE_DRY_RUN === "true",
  log: process.env.VBOXMANAGE_DEBUG === "true" ? (msg: string) => console.error(msg) : () => {},
};

export interface VMInfo {
  name: string;
  uuid: string;
  state: string;
  [key: string]: string;
}
