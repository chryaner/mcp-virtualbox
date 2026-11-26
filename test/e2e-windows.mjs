#!/usr/bin/env node
// End-to-end against a Windows guest: the tools a Linux guest cannot prove
// (WinRM, Guest Additions on Windows, a desktop to type and click on), called
// through MCP against a real VirtualBox.
//
// It needs VirtualBox on this machine and the disk of an installed Windows
// that has Guest Additions and logs its user in automatically:
//
//   E2E_DISK      disk image to boot (path or medium UUID). Cloned, never modified.
//   E2E_OSTYPE    VirtualBox OS type, e.g. Windows10_64
//   E2E_USER      Windows user, an administrator
//   E2E_PASSWORD  its password (Guest Additions refuse a blank one)
//   E2E_FIRMWARE  "efi" for an EFI installation (default bios)
//   E2E_SSH       set if the guest runs an OpenSSH server: tests vm_exec_ssh,
//                 and vm_exec_winrm after switching WinRM on through it
//   E2E_CPUS      CPUs for the VM (default 2)
//   E2E_KEEP      set to keep the VM when the run fails
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import { startServer, textOf } from "./mcp-client.mjs";

const run = promisify(execFile);

const DISK = process.env.E2E_DISK;
const OSTYPE = process.env.E2E_OSTYPE;
const USER = process.env.E2E_USER;
const PASSWORD = process.env.E2E_PASSWORD;
const FIRMWARE = process.env.E2E_FIRMWARE || "bios";
const HAS_SSH = Boolean(process.env.E2E_SSH);
if (!DISK || !OSTYPE || !USER || !PASSWORD) {
  console.error("set E2E_DISK, E2E_OSTYPE, E2E_USER and E2E_PASSWORD (see the top of this file)");
  process.exit(2);
}

const VM = `mcp-e2e-win-${randomBytes(3).toString("hex")}`;
const SSH_PORT = 42500 + Math.floor(Math.random() * 200);
const WINRM_PORT = 42700 + Math.floor(Math.random() * 200);
const work = mkdtempSync(join(tmpdir(), "mcp-e2e-win-"));
const vboxManagePath =
  process.env.VBOXMANAGE_PATH ||
  [
    join(process.env.PROGRAMFILES || "C:/Program Files", "Oracle", "VirtualBox", "VBoxManage.exe"),
    "/usr/bin/VBoxManage",
    "/usr/local/bin/VBoxManage",
  ].find((p) => existsSync(p)) ||
  "VBoxManage";

const server = await startServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const creds = { username: USER, password: PASSWORD };
const results = [];
let step = "";
let passed = 0;

function begin(name) {
  step = name;
  console.log(`\n== ${name}`);
}

function ok(what) {
  passed++;
  console.log(`   ok  ${what}`);
}

function check(condition, what, detail = "") {
  if (!condition) throw new Error(`${what}${detail ? `\n       ${detail}` : ""}`);
  ok(what);
}

async function tool(name, args, timeoutMs) {
  const result = await server.call(name, args, timeoutMs);
  if (result.isError) throw new Error(`${name} failed: ${textOf(result)}`);
  return result;
}

async function info() {
  return JSON.parse(textOf(await tool("vm_info", { vm: VM })));
}

// One cmd.exe command line in the guest through Guest Additions. Each word
// is its own argument, as the tool asks.
async function cmd(...words) {
  const result = await server.call("vm_guest_exec", { vm: VM, executable: "C:\\Windows\\System32\\cmd.exe", args: ["/c", ...words], ...creds, timeoutMs: 60_000 }, 90_000);
  return { ok: !result.isError, text: textOf(result).trim() };
}

async function waitForState(state, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await info()).VMState === state) return;
    await sleep(2_000);
  }
  throw new Error(`the VM did not reach state ${state} within ${timeoutMs / 1000}s`);
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// Decodes an 8-bit RGB or RGBA PNG, as VirtualBox writes them, to raw pixels.
function decodePng(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = png[25] === 6 ? 4 : 3;
  const chunks = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + x] = (value + predicted) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

// The share of pixels that differ between two screenshots inside a square
// around a point.
function changedAround(before, after, cx, cy, half) {
  const a = decodePng(before);
  const b = decodePng(after);
  if (a.width !== b.width || a.height !== b.height) return 1;
  let changed = 0;
  let total = 0;
  for (let y = Math.max(0, cy - half); y < Math.min(a.height, cy + half); y++) {
    for (let x = Math.max(0, cx - half); x < Math.min(a.width, cx + half); x++) {
      const at = (y * a.width + x) * a.channels;
      total++;
      if (a.pixels[at] !== b.pixels[at] || a.pixels[at + 1] !== b.pixels[at + 1] || a.pixels[at + 2] !== b.pixels[at + 2]) changed++;
    }
  }
  return changed / total;
}

async function screenshot() {
  return Buffer.from((await tool("vm_screenshot", { vm: VM })).content[0].data, "base64");
}

// Runs one group of checks and records whether it passed, so a group the
// guest cannot do does not hide the ones after it.
async function group(name, label, fn) {
  begin(name);
  try {
    await fn();
    results.push([label, "pass"]);
  } catch (err) {
    console.log(`   FAILED  ${err.message}`);
    results.push([label, "FAIL"]);
  }
}

async function main() {
  begin("vm_create, vm_modify, vm_attach_media, vm_add_nat_port_forward");
  await tool("vm_create", { name: VM, osTypeId: OSTYPE, memoryMB: 4096, cpus: Number(process.env.E2E_CPUS || 2), diskSizeMB: 4096 });
  if (FIRMWARE === "efi") await tool("vm_modify", { vm: VM, args: ["--firmware", "efi"] });
  const disk = join((await info()).CfgFile.replace(/[/\\][^/\\]+$/, ""), "boot.vdi");
  await run(vboxManagePath, ["clonemedium", "disk", DISK, disk, "--format", "VDI"], { maxBuffer: 1 << 24 });
  await tool("vm_attach_media", { vm: VM, storagectl: "SATA", port: 0, type: "hdd", medium: disk });
  await tool("vm_add_nat_port_forward", { vm: VM, name: "ssh", hostPort: SSH_PORT, guestPort: 22 });
  await tool("vm_add_nat_port_forward", { vm: VM, name: "winrm", hostPort: WINRM_PORT, guestPort: 5985 });
  ok(`VM ${VM} built around a clone of the disk`);

  await group("vm_start, vm_wait_for_guest_additions, vm_wait_for_network, vm_get_guest_ip", "Guest Additions", async () => {
    await tool("vm_start", { vm: VM, headless: true });
    check(textOf(await tool("vm_wait_for_guest_additions", { vm: VM, timeoutMs: 420_000 }, 440_000)).includes("running"), "Guest Additions reported running");
    check(textOf(await tool("vm_wait_for_network", { vm: VM, timeoutMs: 180_000 }, 200_000)).includes("Guest IP: 10.0.2.15"), "network reported ready with the NAT address");
    check(JSON.parse(textOf(await tool("vm_get_guest_ip", { vm: VM }))).includes("10.0.2.15"), "guest IP read back");
  });

  await group("vm_guest_exec, vm_guest_copy_to, vm_guest_copy_from", "Guest exec", async () => {
    // Additions report themselves running a little before they take a command.
    let ver = { ok: false, text: "" };
    for (const deadline = Date.now() + 180_000; Date.now() < deadline && !ver.ok; ) {
      ver = await cmd("ver");
      if (!ver.ok) await sleep(5_000);
    }
    check(ver.ok && ver.text.includes("Microsoft Windows"), "a command runs through Guest Additions", ver.text);
    console.log(`       ${ver.text.split("\n").pop()}`);
    check((await cmd("echo", "one", "two")).text === "one two", "arguments arrive separately");
    const wrong = await server.call("vm_guest_exec", { vm: VM, executable: "C:\\Windows\\System32\\cmd.exe", args: ["/c", "ver"], username: USER, password: PASSWORD + "x" });
    check(wrong.isError, "a wrong password is reported as an error");

    const payload = randomBytes(200_000);
    const hostFile = join(work, "payload.bin");
    writeFileSync(hostFile, payload);
    // A directory named without a trailing separator, the form that failed.
    await tool("vm_guest_copy_to", { vm: VM, hostPath: hostFile, guestPath: "C:\\Users\\Public", ...creds });
    const hash = await cmd("certutil", "-hashfile", "C:\\Users\\Public\\payload.bin", "SHA256");
    check(hash.text.replace(/\s/g, "").toLowerCase().includes(sha256(payload)), "a file copied in arrives byte for byte", hash.text.slice(0, 300));
    await cmd("copy", "C:\\Users\\Public\\payload.bin", "C:\\Users\\Public\\back.bin");
    await tool("vm_guest_copy_from", { vm: VM, guestPath: "C:\\Users\\Public\\back.bin", hostPath: work, ...creds });
    check(sha256(readFileSync(join(work, "back.bin"))) === sha256(payload), "and copied out again byte for byte");
  });

  let width = 0;
  let height = 0;
  await group("vm_screenshot, vm_screen_info", "Screenshot", async () => {
    const png = await screenshot();
    check(png.subarray(1, 4).toString() === "PNG" && png.length > 1000, `a real PNG, ${png.length} bytes`);
    const screen = JSON.parse(textOf(await tool("vm_screen_info", { vm: VM })));
    width = Number(screen.width);
    height = Number(screen.height);
    check(png.readUInt32BE(16) === width && png.readUInt32BE(20) === height, `and vm_screen_info agrees on its size: ${width}x${height}`);
  });

  await group("vm_keyboard_scancode, vm_keyboard_type", "Keyboard", async () => {
    // The Run dialog, driven the way the vision loop does: Win+R, a command
    // line, Enter. The command leaves a file the guest can be asked about.
    const marker = "typed-" + randomBytes(4).toString("hex");
    let found = "";
    for (let attempt = 1; attempt <= 4 && found !== marker; attempt++) {
      // After boot the desktop takes a while to take input.
      await sleep(attempt === 1 ? 20_000 : 15_000);
      await tool("vm_keyboard_scancode", { vm: VM, keys: "win+r" });
      await sleep(2_500);
      await tool("vm_keyboard_type", { vm: VM, text: `cmd /c echo ${marker}> C:\\Users\\Public\\typed.txt` });
      await sleep(500);
      await tool("vm_keyboard_scancode", { vm: VM, keys: "enter" });
      await sleep(4_000);
      found = (await cmd("type", "C:\\Users\\Public\\typed.txt")).text;
    }
    check(found === marker, "Win+R, a typed command line and Enter ran the command on the guest's desktop", `the file holds: ${found.slice(0, 200)}`);
  });

  await group("vm_shared_folder_add, vm_shared_folder_remove", "Shared folder", async () => {
    const shareDir = join(work, "share");
    mkdirSync(shareDir);
    writeFileSync(join(shareDir, "from-host.txt"), "from the host\r\n");
    await tool("vm_shared_folder_add", { vm: VM, name: "e2eshare", hostPath: shareDir, automount: false, transient: true });
    // A share belongs to the logged-in desktop session, not to the service
    // session Guest Additions run a command in, so it is used from the
    // desktop: the Run dialog copies a file each way.
    async function runOnDesktop(commandLine) {
      await tool("vm_keyboard_scancode", { vm: VM, keys: "win+r" });
      await sleep(2_500);
      await tool("vm_keyboard_type", { vm: VM, text: commandLine });
      await sleep(500);
      await tool("vm_keyboard_scancode", { vm: VM, keys: "enter" });
      await sleep(5_000);
    }
    await runOnDesktop("cmd /c copy \\\\vboxsvr\\e2eshare\\from-host.txt C:\\Users\\Public\\from-share.txt");
    const read = await cmd("type", "C:\\Users\\Public\\from-share.txt");
    check(read.text === "from the host", "the guest reads a host file through the share", read.text.slice(0, 200));
    await runOnDesktop("cmd /c copy C:\\Users\\Public\\typed.txt \\\\vboxsvr\\e2eshare\\from-guest.txt");
    check(existsSync(join(shareDir, "from-guest.txt")), "and the host sees what the guest wrote");
    await tool("vm_shared_folder_remove", { vm: VM, name: "e2eshare", transient: true });
  });

  await group("vm_mouse_click, vm_mouse_move", "Mouse", async () => {
    // A right click on the empty desktop opens its menu right there, and a
    // left click elsewhere closes it again.
    const cx = Math.round(width * 0.6);
    const cy = Math.round(height * 0.4);
    await tool("vm_mouse_click", { vm: VM, x: 30, y: Math.round(height * 0.5) });
    await sleep(1_500);
    const before = await screenshot();
    await tool("vm_mouse_click", { vm: VM, x: cx, y: cy, button: "right" });
    await sleep(2_500);
    const menu = await screenshot();
    const opened = changedAround(before, menu, cx + 60, cy + 80, 60);
    check(opened > 0.05, `a right click opens the desktop menu at the pointer (${Math.round(opened * 100)}% of the area beside it changed)`);
    await tool("vm_keyboard_scancode", { vm: VM, keys: "escape" });
    await tool("vm_mouse_move", { vm: VM, x: cx, y: cy });
    ok("vm_mouse_move accepted");
  });

  if (HAS_SSH) {
    await group("vm_exec_ssh", "SSH", async () => {
      const result = await server.call("vm_exec_ssh", { port: SSH_PORT, username: USER, password: PASSWORD, command: "hostname", timeoutMs: 30_000 }, 45_000);
      check(!result.isError && /Exit code: 0/.test(textOf(result)), "a command runs over SSH with the password", textOf(result).slice(0, 300));
    });

    await group("vm_exec_winrm", "WinRM", async () => {
      // WinRM is off on a client Windows. Switching it on needs elevation,
      // which an SSH session of an administrator has.
      const enable =
        "powershell -NoProfile -Command \"Set-NetConnectionProfile -NetworkCategory Private; " +
        "Enable-PSRemoting -Force -SkipNetworkProfileCheck | Out-Null; " +
        "Set-Item WSMan:\\localhost\\Service\\Auth\\Basic $true; " +
        "Set-Item WSMan:\\localhost\\Service\\AllowUnencrypted $true; " +
        "New-NetFirewallRule -Name winrm-e2e -DisplayName winrm-e2e -Direction Inbound -Protocol TCP -LocalPort 5985 -Action Allow | Out-Null\"";
      const enabled = await server.call("vm_exec_ssh", { port: SSH_PORT, username: USER, password: PASSWORD, command: enable, timeoutMs: 120_000 }, 140_000);
      check(/Exit code: 0/.test(textOf(enabled)), "WinRM switched on through SSH", textOf(enabled).slice(0, 400));
      const plain = await server.call("vm_exec_winrm", { port: WINRM_PORT, ...creds, command: "hostname", timeoutMs: 60_000 }, 80_000);
      check(!plain.isError && textOf(plain).trim().length > 0, "a cmd.exe command runs over WinRM", textOf(plain).slice(0, 300));
      const ps = await server.call("vm_exec_winrm", { port: WINRM_PORT, ...creds, command: "Write-Output (6*7)", usePowershell: true, timeoutMs: 60_000 }, 80_000);
      check(!ps.isError && textOf(ps).includes("42"), "and a PowerShell command", textOf(ps).slice(0, 300));
      const refused = await server.call("vm_exec_winrm", { port: WINRM_PORT, username: USER, password: PASSWORD + "x", command: "hostname", timeoutMs: 30_000 }, 45_000).catch((e) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
      check(refused.isError, "a wrong password is refused");
    });
  }

  if (process.env.E2E_KEEP && results.some(([, result]) => result === "FAIL")) {
    console.log(`
VM ${VM} kept for inspection (ssh port ${SSH_PORT}, winrm port ${WINRM_PORT})`);
    return;
  }
  begin("vm_stop, vm_delete");
  await tool("vm_stop", { vm: VM, method: "poweroff" });
  await waitForState("poweroff");
  await sleep(2_000);
  await tool("vm_delete", { vm: VM, deleteFiles: true });
  check(!JSON.parse(textOf(await tool("vm_list"))).some((v) => v.name === VM), "VM gone from the list");
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.error(`\nFAILED in "${step}": ${err.message}`);
  if (!process.env.E2E_KEEP) {
    await server.call("vm_stop", { vm: VM, method: "poweroff" }).catch(() => {});
    await sleep(3_000);
    await server.call("vm_delete", { vm: VM, deleteFiles: true }).catch(() => {});
  } else {
    console.error(`VM ${VM} kept for inspection`);
  }
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}
console.log(`\n${OSTYPE}: ${results.map(([label, result]) => `${label} ${result}`).join(", ")}`);
if (results.some(([, result]) => result === "FAIL")) failed = true;
console.log(failed ? "FAILED" : `ALL PASS: ${passed} checks`);
process.exit(failed ? 1 : 0);
