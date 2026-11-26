// Mouse input through VirtualBox's own web service.
//
// VBoxManage can type and take screenshots but has no command for the mouse:
// that needs VirtualBox's Main API. Every VirtualBox installation ships a
// server for that API, vboxwebsrv, which speaks SOAP over HTTP. This module
// starts one for the lifetime of this process and sends it the few calls a
// mouse event takes, so the mouse works wherever VirtualBox is installed,
// with nothing else to set up.
//
// The service is bound to loopback on a port picked at start, and it only
// accepts a user name and password made up at start and registered with
// VirtualBox's simple authenticator: binding to loopback alone would let any
// other user of the machine drive this user's VMs. Both go away with the
// process.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { createServer, connect } from "node:net";
import { dirname, posix, win32 } from "node:path";
import { config } from "./types.js";
import { vboxManage } from "./vbox.js";

export const MOUSE_BUTTONS = { left: 0x01, right: 0x02, middle: 0x04 } as const;
export type MouseButton = keyof typeof MOUSE_BUTTONS;

// One absolute mouse state: where the pointer is, in screenshot pixels, and
// which buttons are held while it is there.
export interface MouseEvent {
  x: number;
  y: number;
  buttons: number;
}

// ---- SOAP ----------------------------------------------------------------

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The request for one method. Arguments go in the order given, which has to
// be the order the service's WSDL declares.
export function soapEnvelope(method: string, args: Array<[string, string | number | boolean]>): string {
  const body = args.map(([name, value]) => `<${name}>${escapeXml(String(value))}</${name}>`).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:vbox="http://www.virtualbox.org/">` +
    `<soap:Body><vbox:${method}>${body}</vbox:${method}></soap:Body></soap:Envelope>`
  );
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function element(xml: string, name: string): string | undefined {
  // Local names only: the service chooses its own namespace prefixes.
  const match = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`));
  return match ? unescapeXml(match[1].trim()) : undefined;
}

// The answer to one method: its return value, empty for a method that
// returns nothing, or the fault the service raised instead.
export function parseSoapResponse(xml: string): { value: string; fault?: string } {
  if (!/<(?:[\w-]+:)?Envelope[\s>]/.test(xml)) {
    return { value: "", fault: "the reply is not a SOAP envelope" };
  }
  if (/<(?:[\w-]+:)?Fault[\s>]/.test(xml)) {
    // A refused login comes back as a fault with a code and no text.
    return { value: "", fault: element(xml, "faultstring") || element(xml, "faultcode") || "unexplained fault" };
  }
  return { value: element(xml, "returnval") ?? "" };
}

// Screenshot pixels count from 0; the API counts absolute positions from 1.
export function apiCoordinate(pixel: number): number {
  return Math.round(pixel) + 1;
}

// The password VBoxAuthSimple stores for a user: the SHA-256 of it, in hex.
export function authSimpleHash(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

// ---- the service ---------------------------------------------------------

// Where vboxwebsrv lives: next to VBoxManage, whatever that was found as.
export function webServiceCandidates(vboxManagePath: string, platform: NodeJS.Platform = process.platform): string[] {
  const name = platform === "win32" ? "VBoxWebSrv.exe" : "vboxwebsrv";
  // The path rules of the platform asked about, not of the one running this.
  const paths = platform === "win32" ? win32 : posix;
  const dirs: string[] = [];
  if (paths.dirname(vboxManagePath) !== ".") {
    dirs.push(paths.dirname(vboxManagePath));
    try {
      // VBoxManage is often a link into the installation folder.
      if (platform === process.platform) dirs.push(dirname(realpathSync(vboxManagePath)));
    } catch {
      // The path as given is still worth trying.
    }
  }
  if (platform === "darwin") dirs.push("/Applications/VirtualBox.app/Contents/MacOS");
  if (platform === "linux") dirs.push("/usr/lib/virtualbox", "/opt/VirtualBox");
  return [...new Set(dirs)].map((dir) => paths.join(dir, name));
}

function findWebService(): string {
  if (process.env.VBOXWEBSRV_PATH) return process.env.VBOXWEBSRV_PATH;
  const found = webServiceCandidates(config.vboxManagePath).find((p) => existsSync(p));
  // Not found beside VBoxManage: it may still be on PATH, as VBoxManage is
  // when it was not found at a known location either.
  return found ?? (process.platform === "win32" ? "VBoxWebSrv.exe" : "vboxwebsrv");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Service {
  endpoint: string;
  user: string;
  password: string;
  process: ChildProcess;
}

let starting: Promise<Service> | undefined;

const USER_PREFIX = "mcp-virtualbox-";

// The process ids of the web service users registered by this program, read
// from `VBoxManage getextradata global enumerate`.
export function registeredUserPids(extradata: string): number[] {
  const pids: number[] = [];
  for (const match of extradata.matchAll(/^Key: VBoxAuthSimple\/users\/mcp-virtualbox-(\d+),/gm)) {
    pids.push(Number(match[1]));
  }
  return pids;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists and belongs to someone else. Anything else: gone.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A server that is killed outright cannot take its user out of VirtualBox's
// settings on the way out, so each start removes the ones whose process is
// gone. The password hash of a dead process opens nothing - no service is
// left to check it - but they would pile up.
async function forgetDeadUsers(): Promise<void> {
  try {
    const extradata = await vboxManage("getextradata", "global", "enumerate");
    for (const pid of registeredUserPids(extradata)) {
      if (pid !== process.pid && !alive(pid)) {
        await vboxManage("setextradata", "global", `VBoxAuthSimple/users/${USER_PREFIX}${pid}`);
      }
    }
  } catch {
    // Tidying up is never a reason to refuse a click.
  }
}

async function start(): Promise<Service> {
  const binary = findWebService();
  const port = await freePort();
  // A user of this process's own, so two servers running at once do not
  // overwrite each other's password.
  const user = `${USER_PREFIX}${process.pid}`;
  const password = randomBytes(24).toString("hex");
  await forgetDeadUsers();
  await vboxManage("setextradata", "global", `VBoxAuthSimple/users/${user}`, authSimpleHash(password));

  const child = spawn(binary, ["--host", "127.0.0.1", "--port", String(port), "--authentication", "VBoxAuthSimple"], {
    stdio: "ignore",
    windowsHide: true,
  });
  let exit: string | undefined;
  child.once("error", (err) => { exit = err.message; });
  child.once("exit", (code) => { exit ??= `exited with code ${code}`; });

  const forget = () => {
    child.kill();
    // Best effort, and not awaited: the process is on its way out.
    vboxManage("setextradata", "global", `VBoxAuthSimple/users/${user}`).catch(() => {});
  };
  process.once("exit", () => child.kill());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      forget();
      process.exit(0);
    });
  }

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (exit) break;
    if (await accepts(port)) {
      config.log(`[webservice] ${binary} listening on 127.0.0.1:${port}`);
      return { endpoint: `http://127.0.0.1:${port}/`, user, password, process: child };
    }
    await sleep(200);
  }
  forget();
  throw new Error(
    exit
      ? `could not start the VirtualBox web service (${binary}): ${exit}`
      : `the VirtualBox web service (${binary}) did not start listening within 20s`,
  );
}

// The running service, started on first use. A start that failed is not
// remembered, so the next call tries again.
function service(): Promise<Service> {
  starting ??= start().catch((err) => {
    starting = undefined;
    throw err;
  });
  return starting;
}

async function call(svc: Service, method: string, args: Array<[string, string | number | boolean]>): Promise<string> {
  const response = await fetch(svc.endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '""' },
    body: soapEnvelope(method, args),
    signal: AbortSignal.timeout(config.defaultTimeout),
  });
  const { value, fault } = parseSoapResponse(await response.text());
  if (fault) throw new Error(`${method}: ${fault}`);
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  return value;
}

// Logs on, attaches to the running VM the way a second window would, and
// hands fn a function that calls a method on the VM's mouse. It always
// unlocks and logs off again.
async function withMouse<T>(
  vm: string,
  fn: (mouse: (method: string, args: Array<[string, string | number | boolean]>) => Promise<string>) => Promise<T>,
): Promise<T> {
  const svc = await service();
  const vbox = await call(svc, "IWebsessionManager_logon", [["username", svc.user], ["password", svc.password]]);
  try {
    const machine = await call(svc, "IVirtualBox_findMachine", [["_this", vbox], ["nameOrId", vm]]);
    const session = await call(svc, "IWebsessionManager_getSessionObject", [["refIVirtualBox", vbox]]);
    await call(svc, "IMachine_lockMachine", [["_this", machine], ["session", session], ["lockType", "Shared"]]);
    try {
      const console = await call(svc, "ISession_getConsole", [["_this", session]]);
      if (!console) throw new Error(`VM "${vm}" is not running`);
      const mouse = await call(svc, "IConsole_getMouse", [["_this", console]]);
      return await fn((method, args) => call(svc, method, [["_this", mouse], ...args]));
    } finally {
      await call(svc, "ISession_unlockMachine", [["_this", session]]).catch(() => {});
    }
  } finally {
    await call(svc, "IWebsessionManager_logoff", [["refIVirtualBox", vbox]]).catch(() => {});
  }
}

// How long a button has to stay down, or up, for the guest to notice. Measured
// against a Linux guest: with 50 ms between a press and its release half the
// clicks arrived as a move with no button at all, with 100 ms every one did.
export const BUTTON_SETTLE_MS = 120;

// The pause before event i: a change of button state gets the full settle
// time, a pointer that only moves can go as fast as asked.
export function pauseBefore(events: MouseEvent[], i: number, gapMs: number): number {
  if (i === 0) return 0;
  return events[i].buttons !== events[i - 1].buttons ? Math.max(gapMs, BUTTON_SETTLE_MS) : gapMs;
}

// Sends absolute mouse states in order, pausing between them so the guest
// sees separate events rather than one.
export async function putMouseEvents(vm: string, events: MouseEvent[], gapMs = 20): Promise<void> {
  await withMouse(vm, async (mouse) => {
    if ((await mouse("IMouse_getAbsoluteSupported", [])) === "false") {
      throw new Error(
        `VM "${vm}" has no absolute pointing device, so a position cannot be sent to it. ` +
          `Power it off and run vm_modify with ["--mouse", "usbtablet"] (vm_create sets this up).`,
      );
    }
    for (let i = 0; i < events.length; i++) {
      const pause = pauseBefore(events, i, gapMs);
      if (pause > 0) await sleep(pause);
      const ev = events[i];
      await mouse("IMouse_putMouseEventAbsolute", [
        ["x", apiCoordinate(ev.x)],
        ["y", apiCoordinate(ev.y)],
        ["dz", 0],
        ["dw", 0],
        ["buttonState", ev.buttons],
      ]);
    }
  });
}

// Turns the wheel where the pointer is. Positive scrolls down, as the API
// counts it.
export async function putMouseWheel(vm: string, clicks: number): Promise<void> {
  await withMouse(vm, async (mouse) => {
    await mouse("IMouse_putMouseEvent", [["dx", 0], ["dy", 0], ["dz", clicks], ["dw", 0], ["buttonState", 0]]);
  });
}
