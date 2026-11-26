import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { vboxManage, formatError } from "../vbox.js";

function credentialArgs(username: string, password: string): string[] {
  const args = ["--username", username];
  if (password) args.push("--password", password);
  return args;
}

// VirtualBox 7 takes a copy destination as a directory only when it ends in a
// path separator. Anything else is the name of the file to write, and naming
// a directory that exists that way is an error ("already exists and is a
// directory") rather than a copy into it, which is what earlier versions did
// and what a caller means. So that one error is answered by trying again with
// the separator added. Returns the destination that worked.
async function copyToDestination(dest: string, copy: (target: string) => Promise<unknown>): Promise<string> {
  try {
    await copy(dest);
    return dest;
  } catch (e) {
    if (/[/\\]$/.test(dest) || !/already exists and is a directory/i.test(formatError(e))) throw e;
    const asDirectory = dest + (dest.includes("\\") && !dest.includes("/") ? "\\" : "/");
    await copy(asDirectory);
    return asDirectory;
  }
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
      hostPath: z.string().describe("File on the host to copy"),
      guestPath: z.string().describe("Destination in the guest: a directory that exists (the file keeps its name), or the full path of the file to write. The directory it goes into must already exist."),
      username: z.string().describe("Guest OS username"),
      password: z.string().default("").describe("Guest OS password"),
    },
    async ({ vm, hostPath, guestPath, username, password }) => {
      const dest = await copyToDestination(guestPath, (target) => vboxManage(
        "guestcontrol", vm, "copyto",
        "--target-directory", target,
        ...credentialArgs(username, password),
        hostPath,
      ));
      return { content: [{ type: "text", text: `Copied "${hostPath}" → guest:"${dest}"` }] };
    },
  );

  server.tool(
    "vm_guest_copy_from",
    "Copy a file from guest to host via Guest Additions",
    {
      vm: z.string().describe("VM name or UUID"),
      guestPath: z.string().describe("File in the guest to copy"),
      hostPath: z.string().describe("Destination on the host: a directory that exists (the file keeps its name), or the full path of the file to write. The directory it goes into must already exist."),
      username: z.string().describe("Guest OS username"),
      password: z.string().default("").describe("Guest OS password"),
    },
    async ({ vm, guestPath, hostPath, username, password }) => {
      const dest = await copyToDestination(hostPath, (target) => vboxManage(
        "guestcontrol", vm, "copyfrom",
        "--target-directory", target,
        ...credentialArgs(username, password),
        guestPath,
      ));
      return { content: [{ type: "text", text: `Copied guest:"${guestPath}" → "${dest}"` }] };
    },
  );
}
