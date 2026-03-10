import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import { vboxManage, parseVMList, parseMachineReadable, formatError } from "../vbox.js";

// OS types that lack SATA/AHCI drivers and need IDE for disk
const LEGACY_OS_TYPES = new Set([
  "WindowsXP", "WindowsXP_64",
  "Windows2000", "Windows2003", "Windows2003_64",
  "WindowsMe", "Windows98", "Windows95",
  "WindowsNT4", "WindowsNT3x",
  "Windows31",
  "DOS",
]);

function isLegacyOS(osTypeId: string): boolean {
  return LEGACY_OS_TYPES.has(osTypeId) || /^(WindowsXP|Windows200[03]|Windows9|WindowsMe|WindowsNT|Windows31|DOS)/i.test(osTypeId);
}

function getOSDefaults(osTypeId: string): { memoryMB: number; cpus: number; diskSizeMB: number } {
  if (/^(DOS|Windows31|Windows95)/i.test(osTypeId)) return { memoryMB: 64, cpus: 1, diskSizeMB: 2000 };
  if (/^(Windows98|WindowsMe)/i.test(osTypeId)) return { memoryMB: 256, cpus: 1, diskSizeMB: 4000 };
  if (/^(WindowsNT|Windows2000)/i.test(osTypeId)) return { memoryMB: 512, cpus: 1, diskSizeMB: 8000 };
  if (/^WindowsXP/i.test(osTypeId)) return { memoryMB: 512, cpus: 1, diskSizeMB: 10000 };
  if (/^Windows2003/i.test(osTypeId)) return { memoryMB: 1024, cpus: 1, diskSizeMB: 20000 };
  if (/^(WindowsVista|Windows2008|Windows7)/i.test(osTypeId)) return { memoryMB: 2048, cpus: 2, diskSizeMB: 40000 };
  if (/^(Windows8|Windows2012|Windows10|Windows11|Windows2016|Windows2019|Windows2022)/i.test(osTypeId)) return { memoryMB: 4096, cpus: 2, diskSizeMB: 50000 };
  if (/^(Ubuntu|Debian|Fedora|RedHat|Linux)/i.test(osTypeId)) return { memoryMB: 2048, cpus: 2, diskSizeMB: 25000 };
  return { memoryMB: 2048, cpus: 2, diskSizeMB: 40000 };
}

export function registerLifecycleTools(server: McpServer) {
  server.tool("vm_list", "List all VirtualBox VMs with their state", {}, async () => {
    const [all, running] = await Promise.all([
      vboxManage("list", "vms"),
      vboxManage("list", "runningvms"),
    ]);
    const vms = parseVMList(all);
    const runningUuids = new Set(parseVMList(running).map(v => v.uuid));
    const result = vms.map(vm => ({
      ...vm,
      state: runningUuids.has(vm.uuid) ? "running" : "poweroff",
    }));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("vm_info", "Get detailed VM info", { vm: z.string().describe("VM name or UUID") }, async ({ vm }) => {
    const output = await vboxManage("showvminfo", vm, "--machinereadable");
    const info = parseMachineReadable(output);
    return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
  });

  server.tool(
    "vm_create",
    "Create a new VM with OS type, RAM, disk, CPU, controllers, and USB tablet mouse. Auto-detects legacy OS types (WindowsXP, Windows2000, DOS, etc.) and uses IDE instead of SATA since they lack AHCI drivers. Defaults for RAM/CPU/disk are chosen based on OS type if not specified.",
    {
      name: z.string().describe("VM name"),
      osTypeId: z.string().describe("OS type ID (use vm_list_ostypes to find)"),
      memoryMB: z.number().optional().describe("RAM in MB (auto-detected from OS type if not set)"),
      cpus: z.number().optional().describe("Number of CPUs (auto-detected from OS type if not set)"),
      diskSizeMB: z.number().optional().describe("Disk size in MB (auto-detected from OS type if not set)"),
      basedir: z.string().optional().describe("Base directory for VM files"),
    },
    async ({ name, osTypeId, memoryMB, cpus, diskSizeMB, basedir }) => {
      const defaults = getOSDefaults(osTypeId);
      const finalMemory = memoryMB ?? defaults.memoryMB;
      const finalCpus = cpus ?? defaults.cpus;
      const finalDisk = diskSizeMB ?? defaults.diskSizeMB;
      const legacy = isLegacyOS(osTypeId);

      // Create VM
      const createArgs = ["createvm", "--name", name, "--ostype", osTypeId, "--register"];
      if (basedir) createArgs.push("--basefolder", basedir);
      await vboxManage(...createArgs);

      // Get VM folder path
      const info = parseMachineReadable(await vboxManage("showvminfo", name, "--machinereadable"));
      const cfgFile = info["CfgFile"] || "";
      const vmDir = cfgFile.replace(/[/\\][^/\\]+$/, "");

      // Configure VM settings
      await vboxManage(
        "modifyvm", name,
        "--memory", String(finalMemory),
        "--cpus", String(finalCpus),
        "--mouse", "usbtablet",
        "--graphicscontroller", "vboxsvga",
        "--vram", "128",
        "--audio-enabled", "off",
        "--nic1", "nat",
      );

      // Create and attach disk
      const diskPath = join(vmDir, `${name}.vdi`);
      await vboxManage("createmedium", "disk", "--filename", diskPath, "--size", String(finalDisk), "--format", "VDI");

      if (legacy) {
        // Legacy OS: IDE only - HDD on primary master, DVD on secondary master
        await vboxManage("storagectl", name, "--name", "IDE", "--add", "ide");
        await vboxManage("storageattach", name, "--storagectl", "IDE", "--port", "0", "--device", "0", "--type", "hdd", "--medium", diskPath);
        // Leave IDE port 1 device 0 free for CD/DVD
      } else {
        // Modern OS: SATA for disk, IDE for DVD
        await vboxManage("storagectl", name, "--name", "SATA", "--add", "sata", "--controller", "IntelAhci", "--portcount", "2");
        await vboxManage("storagectl", name, "--name", "IDE", "--add", "ide");
        await vboxManage("storageattach", name, "--storagectl", "SATA", "--port", "0", "--device", "0", "--type", "hdd", "--medium", diskPath);
      }

      const storageNote = legacy
        ? "Storage: IDE only (legacy OS - no AHCI/SATA drivers). HDD on IDE port 0, attach ISO to IDE port 1."
        : "Storage: SATA for HDD, IDE for DVD. Attach ISO to IDE port 0.";

      return { content: [{ type: "text", text: `VM "${name}" created successfully.\nOS: ${osTypeId}, RAM: ${finalMemory}MB, CPUs: ${finalCpus}, Disk: ${finalDisk}MB\nUSB tablet mouse enabled for absolute positioning.\n${storageNote}` }] };
    },
  );

  server.tool(
    "vm_start",
    "Start a VM",
    {
      vm: z.string().describe("VM name or UUID"),
      headless: z.boolean().default(true).describe("Start headless (true) or with GUI (false)"),
    },
    async ({ vm, headless }) => {
      const type = headless ? "headless" : "gui";
      await vboxManage("startvm", vm, "--type", type);
      return { content: [{ type: "text", text: `VM "${vm}" started (${type}).` }] };
    },
  );

  server.tool(
    "vm_stop",
    "Stop a VM",
    {
      vm: z.string().describe("VM name or UUID"),
      method: z.enum(["poweroff", "acpipowerbutton", "savestate"]).default("poweroff").describe("Stop method"),
    },
    async ({ vm, method }) => {
      await vboxManage("controlvm", vm, method);
      return { content: [{ type: "text", text: `VM "${vm}" stopped (${method}).` }] };
    },
  );

  server.tool(
    "vm_delete",
    "Delete a VM and optionally all its files (disks, snapshots, etc.)",
    {
      vm: z.string().describe("VM name or UUID"),
      deleteFiles: z.boolean().default(true).describe("Also delete all associated files (disk images, etc.)"),
    },
    async ({ vm, deleteFiles }) => {
      const args = ["unregistervm", vm];
      if (deleteFiles) args.push("--delete");
      await vboxManage(...args);
      return { content: [{ type: "text", text: `VM "${vm}" deleted${deleteFiles ? " (with all files)" : " (unregistered only)"}.` }] };
    },
  );

  server.tool(
    "vm_pause",
    "Pause a running VM",
    { vm: z.string().describe("VM name or UUID") },
    async ({ vm }) => {
      await vboxManage("controlvm", vm, "pause");
      return { content: [{ type: "text", text: `VM "${vm}" paused.` }] };
    },
  );

  server.tool(
    "vm_resume",
    "Resume a paused VM",
    { vm: z.string().describe("VM name or UUID") },
    async ({ vm }) => {
      await vboxManage("controlvm", vm, "resume");
      return { content: [{ type: "text", text: `VM "${vm}" resumed.` }] };
    },
  );

  server.tool(
    "vm_reset",
    "Hard reset a running VM (like pressing the reset button)",
    { vm: z.string().describe("VM name or UUID") },
    async ({ vm }) => {
      await vboxManage("controlvm", vm, "reset");
      return { content: [{ type: "text", text: `VM "${vm}" reset.` }] };
    },
  );

  server.tool(
    "vm_shared_folder_add",
    "Add a shared folder between host and guest. Requires Guest Additions in the guest. The folder appears as a network drive in Windows guests or can be mounted in Linux guests.",
    {
      vm: z.string().describe("VM name or UUID"),
      name: z.string().describe("Share name (used to identify the folder in the guest)"),
      hostPath: z.string().describe("Absolute path on the host to share"),
      writable: z.boolean().default(true).describe("Allow the guest to write to the folder"),
      automount: z.boolean().default(true).describe("Auto-mount in the guest"),
      transient: z.boolean().default(false).describe("Temporary share that does not persist across VM restarts (can be added while VM is running)"),
    },
    async ({ vm, name, hostPath, writable, automount, transient }) => {
      const args = transient
        ? ["sharedfolder", "add", vm, "--name", name, "--hostpath", hostPath, "--transient"]
        : ["sharedfolder", "add", vm, "--name", name, "--hostpath", hostPath];
      if (!writable) args.push("--readonly");
      if (automount) args.push("--automount");
      await vboxManage(...args);
      return { content: [{ type: "text", text: `Shared folder "${name}" added: host "${hostPath}" → guest (${writable ? "read-write" : "read-only"}${transient ? ", transient" : ""}).` }] };
    },
  );

  server.tool(
    "vm_shared_folder_remove",
    "Remove a shared folder from a VM",
    {
      vm: z.string().describe("VM name or UUID"),
      name: z.string().describe("Share name to remove"),
      transient: z.boolean().default(false).describe("Remove a transient share (must match how it was added)"),
    },
    async ({ vm, name, transient }) => {
      const args = ["sharedfolder", "remove", vm, "--name", name];
      if (transient) args.push("--transient");
      await vboxManage(...args);
      return { content: [{ type: "text", text: `Shared folder "${name}" removed from "${vm}".` }] };
    },
  );

  server.tool(
    "vm_attach_media",
    "Attach ISO/disk to VM, eject media, or attach Guest Additions ISO. For legacy OS VMs (XP, 2000, etc.) ISO goes on IDE port 1 device 0. For modern OS VMs, ISO goes on IDE port 0 device 0.",
    {
      vm: z.string().describe("VM name or UUID"),
      storagectl: z.string().default("IDE").describe("Storage controller name"),
      port: z.number().default(0).describe("Port number"),
      device: z.number().default(0).describe("Device number"),
      type: z.enum(["dvddrive", "hdd"]).default("dvddrive").describe("Medium type"),
      medium: z.string().describe("Path to ISO/disk, 'emptydrive' to eject, or 'additions' for Guest Additions ISO"),
    },
    async ({ vm, storagectl, port, device, type, medium }) => {
      await vboxManage("storageattach", vm, "--storagectl", storagectl, "--port", String(port), "--device", String(device), "--type", type, "--medium", medium);
      return { content: [{ type: "text", text: `Attached "${medium}" to ${vm} (${storagectl} port ${port}).` }] };
    },
  );

  server.tool(
    "vm_snapshot",
    "Manage VM snapshots",
    {
      vm: z.string().describe("VM name or UUID"),
      action: z.enum(["take", "restore", "delete", "list"]).describe("Snapshot action"),
      snapshotName: z.string().optional().describe("Snapshot name (required for take/restore/delete)"),
    },
    async ({ vm, action, snapshotName }) => {
      if (action === "list") {
        try {
          const output = await vboxManage("snapshot", vm, "list", "--machinereadable");
          return { content: [{ type: "text", text: output }] };
        } catch (e) {
          const msg = formatError(e);
          if (msg.includes("does not have any snapshots")) {
            return { content: [{ type: "text", text: "No snapshots." }] };
          }
          return { content: [{ type: "text", text: `Snapshot list failed: ${msg}` }], isError: true };
        }
      }
      if (!snapshotName) {
        return { content: [{ type: "text", text: "snapshotName is required for take/restore/delete." }], isError: true };
      }
      if (action === "take") {
        await vboxManage("snapshot", vm, "take", snapshotName);
      } else if (action === "restore") {
        await vboxManage("snapshot", vm, "restore", snapshotName);
      } else if (action === "delete") {
        await vboxManage("snapshot", vm, "delete", snapshotName);
      }
      return { content: [{ type: "text", text: `Snapshot "${snapshotName}" ${action} completed on "${vm}".` }] };
    },
  );

  server.tool(
    "vm_modify",
    "Modify arbitrary VM settings via VBoxManage modifyvm",
    {
      vm: z.string().describe("VM name or UUID"),
      args: z.array(z.string()).describe("Arguments to pass to modifyvm (e.g. ['--memory', '4096'])"),
    },
    async ({ vm, args }) => {
      await vboxManage("modifyvm", vm, ...args);
      return { content: [{ type: "text", text: `Modified "${vm}" with args: ${args.join(" ")}` }] };
    },
  );

  server.tool("vm_list_ostypes", "List available OS type IDs for VM creation", {}, async () => {
    const output = await vboxManage("list", "ostypes");
    // Parse into compact list - handles both old ("ID:" + "Description:") and new ("ID / Description: id -- desc") formats
    const types: Array<{ id: string; description: string }> = [];
    let currentId = "";
    for (const line of output.split("\n")) {
      // New format (VirtualBox 7.1+): "ID / Description: WindowsXP -- Windows XP"
      const combinedMatch = line.match(/^ID\s*\/\s*Description:\s+(\S+)\s+--\s+(.+)/);
      if (combinedMatch) {
        types.push({ id: combinedMatch[1].trim(), description: combinedMatch[2].trim() });
        continue;
      }
      // Old format: separate "ID:" and "Description:" lines
      const idMatch = line.match(/^ID:\s+(.+)/);
      const descMatch = line.match(/^Description:\s+(.+)/);
      if (idMatch) currentId = idMatch[1].trim();
      if (descMatch && currentId) {
        types.push({ id: currentId, description: descMatch[1].trim() });
        currentId = "";
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(types, null, 2) }] };
  });
}
