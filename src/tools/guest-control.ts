import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { vboxManage, formatError } from "../vbox.js";

function credentialArgs(username: string, password: string): string[] {
  const args = ["--username", username];
  if (password) args.push("--password", password);
  return args;
}

export function registerGuestControlTools(server: McpServer) {
  server.tool(
    "vm_guest_exec",
    "Execute a command inside the guest via Guest Additions (no network required). Guest Additions must be installed and running.",
    {
      vm: z.string().describe("VM name or UUID"),
      executable: z.string().describe("Path to executable inside guest. For Windows commands, use C:\\WINDOWS\\system32\\cmd.exe with args [\"/c\", \"command\", \"arg1\", \"arg2\"]"),
      args: z.array(z.string()).default([]).describe("Command arguments. IMPORTANT: Each argument must be a SEPARATE array element. Do NOT combine command+args into one string. Example: [\"/c\", \"dir\", \"C:\\\\\"] not [\"/c\", \"dir C:\\\\\"). Also: VBoxManage guestcontrol breaks arguments containing spaces - avoid paths with spaces in args. For complex commands, use vm_guest_copy_to to write a .bat/.sh script, then execute it."),
      username: z.string().describe("Guest OS username"),
      password: z.string().default("").describe("Guest OS password. IMPORTANT: Windows accounts with BLANK passwords CANNOT use guestcontrol - you must set a password first (use vision loop: Win+R → cmd → 'net user <name> <pass>')"),
      timeoutMs: z.number().default(30000).describe("Timeout in ms"),
    },
    async ({ vm, executable, args, username, password, timeoutMs }) => {
      const vboxArgs = [
        "guestcontrol", vm, "run",
        "--exe", executable,
        ...credentialArgs(username, password),
        "--wait-stdout", "--wait-stderr",
        "--timeout", String(timeoutMs),
      ];
      if (args.length > 0) {
        vboxArgs.push("--", ...args);
      }

      try {
        const output = await vboxManage(...vboxArgs);
        return { content: [{ type: "text", text: output || "(no output)" }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Guest exec failed: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "vm_guest_copy_to",
    "Copy a file from host to guest via Guest Additions",
    {
      vm: z.string().describe("VM name or UUID"),
      hostPath: z.string().describe("Path on host"),
      guestPath: z.string().describe("Path on guest"),
      username: z.string().describe("Guest OS username"),
      password: z.string().default("").describe("Guest OS password"),
    },
    async ({ vm, hostPath, guestPath, username, password }) => {
      await vboxManage(
        "guestcontrol", vm, "copyto",
        "--target-directory", guestPath,
        ...credentialArgs(username, password),
        hostPath,
      );
      return { content: [{ type: "text", text: `Copied "${hostPath}" → guest:"${guestPath}"` }] };
    },
  );

  server.tool(
    "vm_guest_copy_from",
    "Copy a file from guest to host via Guest Additions",
    {
      vm: z.string().describe("VM name or UUID"),
      guestPath: z.string().describe("Path on guest"),
      hostPath: z.string().describe("Path on host"),
      username: z.string().describe("Guest OS username"),
      password: z.string().default("").describe("Guest OS password"),
    },
    async ({ vm, guestPath, hostPath, username, password }) => {
      await vboxManage(
        "guestcontrol", vm, "copyfrom",
        "--target-directory", hostPath,
        ...credentialArgs(username, password),
        guestPath,
      );
      return { content: [{ type: "text", text: `Copied guest:"${guestPath}" → "${hostPath}"` }] };
    },
  );
}
