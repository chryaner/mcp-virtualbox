#!/usr/bin/env node
// End-to-end: every tool that can run against a Linux guest, called through
// MCP against a real VirtualBox and a VM that really boots. The unit tests
// mock VBoxManage; this is the proof the tools work.
//
// It needs VirtualBox on this machine and a bootable Linux disk image with a
// user that has passwordless sudo and accepts an SSH key:
//
//   E2E_DISK      disk image to boot (VDI, VMDK, VHD). Cloned, never modified.
//   E2E_USER      user inside the guest
//   E2E_KEY       path to that user's SSH private key
//   E2E_SEED      optional cloud-init seed ISO, for an image not yet set up
//   E2E_PASSWORD  optional: also test SSH password login with it
//   E2E_OSTYPE    VirtualBox OS type (default Ubuntu_64)
//   E2E_MAC       optional MAC address for the VM, for an image whose network
//                 settings are tied to the card it was installed with
//   E2E_KEEP      set to keep the VM when the run fails
//   E2E_SKIP      steps to leave out: "mouse" where the Python bindings
//                 vm_mouse_click needs are not installed
//
// The guest needs internet access to install its Guest Additions service.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startServer, textOf } from "./mcp-client.mjs";

const run = promisify(execFile);

const DISK = process.env.E2E_DISK;
const USER = process.env.E2E_USER;
const KEY_PATH = process.env.E2E_KEY;
const SEED = process.env.E2E_SEED;
const SSH_PASSWORD = process.env.E2E_PASSWORD;
const OSTYPE = process.env.E2E_OSTYPE || "Ubuntu_64";
const MAC = process.env.E2E_MAC;
const SKIP = new Set((process.env.E2E_SKIP || "").split(",").filter(Boolean));
if (!DISK || !USER || !KEY_PATH) {
  console.error("set E2E_DISK, E2E_USER and E2E_KEY (see the top of this file)");
  process.exit(2);
}

const VM = `mcp-e2e-${randomBytes(3).toString("hex")}`;
const SSH_PORT = 42000 + Math.floor(Math.random() * 500);
// Set inside the guest by this test, for Guest Additions logins, which
// VirtualBox refuses for an account without a password.
const GUEST_PASSWORD = "E2e-" + randomBytes(6).toString("hex");
const privateKey = readFileSync(KEY_PATH, "utf8");
const work = mkdtempSync(join(tmpdir(), "mcp-e2e-"));
// The one VBoxManage call this test makes itself, to clone the boot disk:
// found the same way the server finds it.
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

// Calls a tool and fails the run if the tool reports an error.
async function tool(name, args, timeoutMs) {
  const result = await server.call(name, args, timeoutMs);
  if (result.isError) throw new Error(`${name} failed: ${textOf(result)}`);
  return result;
}

async function info() {
  return JSON.parse(textOf(await tool("vm_info", { vm: VM })));
}

// One command in the guest over SSH, through the tool under test. Returns the
// exit code and stdout; a connection that fails comes back as code null.
async function ssh(command, { timeoutMs = 30_000, auth = { privateKey } } = {}) {
  const result = await server.call(
    "vm_exec_ssh",
    { port: SSH_PORT, username: USER, command, timeoutMs, ...auth },
    timeoutMs + 15_000,
  );
  const text = textOf(result);
  const code = text.match(/^Exit code: (\d+)/m);
  const stdout = text.match(/stdout:\n([\s\S]*?)(?:\nstderr:\n|$)/);
  return { code: result.isError || !code ? null : Number(code[1]), stdout: stdout ? stdout[1].trim() : "", text };
}

async function sshOK(command, options) {
  const r = await ssh(command, options);
  if (r.code !== 0) throw new Error(`guest command failed: ${command}\n       ${r.text}`);
  return r.stdout;
}

async function waitForSSH(timeoutMs = 300_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await ssh("true", { timeoutMs: 8_000 });
    if (r.code === 0) return Math.round((Date.now() - start) / 1000);
    await sleep(3_000);
  }
  throw new Error(`the guest did not answer on SSH within ${timeoutMs / 1000}s`);
}

async function waitForState(state, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await info()).VMState === state) return;
    await sleep(2_000);
  }
  throw new Error(`the VM did not reach state ${state} within ${timeoutMs / 1000}s`);
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function main() {
  begin("vm_list_ostypes, vm_create, vm_info, vm_list");
  const ostypes = JSON.parse(textOf(await tool("vm_list_ostypes")));
  check(ostypes.some((t) => t.id === OSTYPE), `${OSTYPE} is among the ${ostypes.length} OS types`);
  // One CPU: where VirtualBox runs on top of Hyper-V, a Linux guest with more
  // sometimes hangs in the first seconds of its boot.
  await tool("vm_create", { name: VM, osTypeId: OSTYPE, memoryMB: 2048, cpus: 1, diskSizeMB: 4096 });
  let vm = await info();
  check(vm.memory === "2048" && vm.cpus === "1", "created with the memory and CPUs asked for");
  check(vm.hidpointing === "usbtablet", "created with a USB tablet for absolute mouse input");
  let listed = JSON.parse(textOf(await tool("vm_list"))).find((v) => v.name === VM);
  check(listed?.state === "poweroff", "listed, powered off");

  begin("vm_modify");
  await tool("vm_modify", { vm: VM, args: ["--memory", "1536", "--description", "mcp-virtualbox e2e"] });
  check((await info()).memory === "1536", "memory changed");
  if (MAC) {
    await tool("vm_modify", { vm: VM, args: ["--macaddress1", MAC] });
    check((await info()).macaddress1 === MAC.toUpperCase(), "network card address set");
  }

  begin("vm_attach_media: boot disk and seed");
  const disk = join(vm.CfgFile.replace(/[/\\][^/\\]+$/, ""), "boot.vdi");
  await run(vboxManagePath, ["clonemedium", "disk", DISK, disk, "--format", "VDI"], { maxBuffer: 1 << 24 });
  await tool("vm_attach_media", { vm: VM, storagectl: "SATA", port: 0, type: "hdd", medium: disk });
  vm = await info();
  check(vm["SATA-0-0"] === disk, "cloned disk attached as the boot disk");
  if (SEED) {
    await tool("vm_attach_media", { vm: VM, storagectl: "IDE", port: 0, type: "dvddrive", medium: SEED });
    check((await info())["IDE-0-0"] === SEED, "seed ISO in the DVD drive");
  }

  begin("vm_add_nat_port_forward");
  await tool("vm_add_nat_port_forward", { vm: VM, name: "ssh", hostPort: SSH_PORT, guestPort: 22 });
  check(Object.values(await info()).some((v) => v === `ssh,tcp,,${SSH_PORT},,22`), `host port ${SSH_PORT} forwarded to guest port 22`);

  begin("vm_snapshot: take, list");
  await tool("vm_snapshot", { vm: VM, action: "take", snapshotName: "fresh" });
  check(textOf(await tool("vm_snapshot", { vm: VM, action: "list" })).includes('SnapshotName="fresh"'), "snapshot listed");

  begin("vm_start, vm_exec_ssh");
  await tool("vm_start", { vm: VM, headless: true });
  listed = JSON.parse(textOf(await tool("vm_list"))).find((v) => v.name === VM);
  check(listed?.state === "running", "listed as running");
  const bootSeconds = await waitForSSH();
  ok(`guest answers on SSH with the key after ${bootSeconds}s`);
  check((await sshOK("uname -s")) === "Linux", "a command's output comes back");
  const failing = await ssh("exit 7");
  check(failing.code === 7, "a command's exit code comes back");
  const refused = await ssh("true", { timeoutMs: 8_000, auth: { password: "not-the-password" } });
  check(refused.code === null && /error|timeout/i.test(refused.text), "a wrong password is an error, not a hang");
  if (SSH_PASSWORD) {
    check((await ssh("true", { auth: { password: SSH_PASSWORD } })).code === 0, "password login works");
  }

  begin("vm_screenshot, vm_screen_info");
  const shot = (await tool("vm_screenshot", { vm: VM })).content[0];
  const png = Buffer.from(shot.data, "base64");
  check(shot.type === "image" && shot.mimeType === "image/png", "returns an image");
  check(png.subarray(1, 4).toString() === "PNG" && png.length > 1000, `a real PNG, ${png.length} bytes`);
  const screen = JSON.parse(textOf(await tool("vm_screen_info", { vm: VM })));
  check(Number(screen.width) >= 640 && Number(screen.height) >= 400, `resolution reported: ${screen.width}x${screen.height}`);
  check(png.readUInt32BE(16) === Number(screen.width) && png.readUInt32BE(20) === Number(screen.height), "the screenshot is that size");

  begin("vm_keyboard_type, vm_keyboard_scancode");
  // With the login prompt out of the way, a reader on the console receives
  // exactly what is typed.
  await sshOK("sudo systemctl stop getty@tty1");
  const line = "typed-by-mcp-" + randomBytes(4).toString("hex");
  const reader = ssh("sudo sh -c 'timeout 25 head -n1 < /dev/tty1'", { timeoutMs: 40_000 });
  await sleep(3_000);
  await tool("vm_keyboard_type", { vm: VM, text: line });
  await tool("vm_keyboard_scancode", { vm: VM, keys: "enter" });
  check((await reader).stdout === line, "the guest console received the typed line and the Enter");
  const long = "0123456789abcdefghijklmnopqrstuvwxyz".repeat(8);
  const longReader = ssh("sudo sh -c 'timeout 40 head -n1 < /dev/tty1'", { timeoutMs: 55_000 });
  await sleep(3_000);
  await tool("vm_keyboard_type", { vm: VM, text: long });
  await tool("vm_keyboard_scancode", { vm: VM, keys: "enter" });
  check((await longReader).stdout === long, `${long.length} characters arrive with none dropped`);
  const shifted = ssh("sudo sh -c 'timeout 25 head -n1 < /dev/tty1'", { timeoutMs: 40_000 });
  await sleep(3_000);
  await tool("vm_keyboard_scancode", { vm: VM, keys: "shift+a" });
  await tool("vm_keyboard_scancode", { vm: VM, keys: "b", count: 3 });
  await tool("vm_keyboard_scancode", { vm: VM, raw: "1c 9c" });
  check((await shifted).stdout === "Abbb", "a combo, a repeated key and raw scancodes arrive as typed");
  const bad = await server.call("vm_keyboard_scancode", { vm: VM, keys: "no-such-key" });
  check(bad.isError && textOf(bad).includes("Available keys"), "an unknown key is refused with the list of known ones");

  if (SKIP.has("mouse")) {
    console.log("\n== vm_mouse_click: skipped (E2E_SKIP)");
  } else {
    begin("vm_mouse_click");
    // The guest's mouse device delivers bytes only when the pointer really
    // moves or clicks.
    await sshOK("sudo modprobe mousedev");
    const mice = ssh("sudo sh -c 'timeout 25 head -c 3 /dev/input/mice | wc -c'", { timeoutMs: 40_000 });
    await sleep(3_000);
    await tool("vm_mouse_click", { vm: VM, x: 100, y: 100 });
    await tool("vm_mouse_click", { vm: VM, x: 200, y: 150, button: "right" });
    await tool("vm_mouse_click", { vm: VM, x: 120, y: 120, doubleClick: true });
    check((await mice).stdout === "3", "the guest's mouse device saw the clicks");
  }

  begin("Guest Additions: vm_wait_for_guest_additions, vm_wait_for_network, vm_get_guest_ip");
  await sshOK(`echo '${USER}:${GUEST_PASSWORD}' | sudo chpasswd`);
  await sshOK(
    "sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq virtualbox-guest-utils >/dev/null && sudo systemctl restart vboxadd-service virtualbox-guest-utils 2>/dev/null; true",
    { timeoutMs: 600_000 },
  );
  check(textOf(await tool("vm_wait_for_guest_additions", { vm: VM, timeoutMs: 180_000 }, 200_000)).includes("running"), "Guest Additions reported running");
  check(textOf(await tool("vm_wait_for_network", { vm: VM, timeoutMs: 120_000 }, 140_000)).includes("Guest IP: 10.0.2.15"), "network reported ready with the NAT address");
  check(JSON.parse(textOf(await tool("vm_get_guest_ip", { vm: VM }))).includes("10.0.2.15"), "guest IP read back");

  begin("vm_guest_exec, vm_guest_copy_to, vm_guest_copy_from");
  const creds = { username: USER, password: GUEST_PASSWORD };
  // Guest Additions report themselves running a little before they take a
  // command: the first ones can still fail with a session error.
  let uname;
  for (const deadline = Date.now() + 120_000; ; ) {
    uname = await server.call("vm_guest_exec", { vm: VM, executable: "/bin/uname", args: ["-s"], ...creds });
    if (!uname.isError || Date.now() > deadline) break;
    await sleep(5_000);
  }
  check(!uname.isError && textOf(uname).trim() === "Linux", "a command runs through Guest Additions", textOf(uname));
  check(textOf(await tool("vm_guest_exec", { vm: VM, executable: "/bin/echo", args: ["one", "two"], ...creds })).trim() === "one two", "arguments arrive separately");
  const wrong = await server.call("vm_guest_exec", { vm: VM, executable: "/bin/true", username: USER, password: "wrong" });
  check(wrong.isError, "a wrong password is reported as an error");
  const payload = randomBytes(200_000);
  const hostFile = join(work, "payload.bin");
  writeFileSync(hostFile, payload);
  await tool("vm_guest_copy_to", { vm: VM, hostPath: hostFile, guestPath: "/tmp/", ...creds });
  check((await sshOK("sha256sum /tmp/payload.bin | cut -d' ' -f1")) === sha256(payload), "a file copied in arrives byte for byte");
  await sshOK("cp /tmp/payload.bin /tmp/back.bin");
  await tool("vm_guest_copy_from", { vm: VM, guestPath: "/tmp/back.bin", hostPath: work, ...creds });
  check(sha256(readFileSync(join(work, "back.bin"))) === sha256(payload), "and copied out again byte for byte");

  begin("vm_shared_folder_add, vm_shared_folder_remove");
  const shareDir = join(work, "share");
  mkdirSync(shareDir);
  writeFileSync(join(shareDir, "from-host.txt"), "from the host\n");
  await tool("vm_shared_folder_add", { vm: VM, name: "e2eshare", hostPath: shareDir, automount: false, transient: true });
  await sshOK("sudo mkdir -p /mnt/e2e && sudo mount -t vboxsf e2eshare /mnt/e2e");
  check((await sshOK("cat /mnt/e2e/from-host.txt")) === "from the host", "the guest reads a host file through the share");
  await sshOK("echo from the guest | sudo tee /mnt/e2e/from-guest.txt >/dev/null");
  check(readFileSync(join(shareDir, "from-guest.txt"), "utf8").trim() === "from the guest", "and the host reads what the guest wrote");
  await sshOK("sudo umount /mnt/e2e");
  await tool("vm_shared_folder_remove", { vm: VM, name: "e2eshare", transient: true });
  check((await ssh("sudo mount -t vboxsf e2eshare /mnt/e2e")).code !== 0, "after removal the share can no longer be mounted");

  begin("vm_pause, vm_resume");
  await tool("vm_pause", { vm: VM });
  check((await info()).VMState === "paused", "paused");
  check((await ssh("true", { timeoutMs: 6_000 })).code === null, "a paused guest does not answer");
  await tool("vm_resume", { vm: VM });
  check((await info()).VMState === "running", "running again");
  await waitForSSH(60_000);
  ok("and answers again");

  begin("vm_reset");
  await sshOK("touch /tmp/before-reset && sync");
  await tool("vm_reset", { vm: VM });
  await sleep(5_000);
  await waitForSSH();
  check((await ssh("test -e /tmp/before-reset")).code !== 0, "the guest came back from a fresh boot");

  begin("vm_stop, vm_snapshot: restore, delete");
  await sshOK("touch ~/after-snapshot && sync");
  await tool("vm_stop", { vm: VM, method: "acpipowerbutton" });
  await waitForState("poweroff");
  ok("the guest shut itself down on the ACPI power button");
  await tool("vm_snapshot", { vm: VM, action: "restore", snapshotName: "fresh" });
  await tool("vm_start", { vm: VM });
  await waitForSSH();
  check((await ssh("test -e ~/after-snapshot")).code !== 0, "restoring the snapshot rolled the disk back");
  await tool("vm_stop", { vm: VM, method: "poweroff" });
  await waitForState("poweroff");
  ok("powered off");
  await tool("vm_snapshot", { vm: VM, action: "delete", snapshotName: "fresh" });
  check(textOf(await tool("vm_snapshot", { vm: VM, action: "list" })) === "No snapshots.", "snapshot deleted");
  const missing = await server.call("vm_snapshot", { vm: VM, action: "restore" });
  check(missing.isError, "a snapshot action without a name is refused");

  begin("vm_delete");
  await sleep(2_000);
  await tool("vm_delete", { vm: VM, deleteFiles: true });
  check(!JSON.parse(textOf(await tool("vm_list"))).some((v) => v.name === VM), "gone from the list");
  const gone = await server.call("vm_info", { vm: VM });
  check(gone.isError ?? textOf(gone).includes("VBOX_E_OBJECT_NOT_FOUND"), "asking about it is now an error");
}

let failed = false;
try {
  await main();
  console.log(`\nALL PASS: ${passed} checks against VM ${VM}`);
} catch (err) {
  failed = true;
  console.error(`\nFAILED in "${step}": ${err.message}`);
  if (!process.env.E2E_KEEP) {
    await server.call("vm_stop", { vm: VM, method: "poweroff" }).catch(() => {});
    await sleep(3_000);
    await server.call("vm_delete", { vm: VM, deleteFiles: true }).catch(() => {});
  } else {
    console.error(`VM ${VM} kept for inspection (ssh port ${SSH_PORT}, guest password ${GUEST_PASSWORD})`);
  }
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
