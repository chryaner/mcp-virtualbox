import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Client as SSHClient } from "ssh2";
import { vboxManage, parseMachineReadable, formatError } from "../vbox.js";

export function registerNetworkExecTools(server: McpServer) {
  server.tool(
    "vm_exec_ssh",
    "Execute a command on a Linux guest via SSH",
    {
      host: z.string().default("127.0.0.1").describe("SSH host (use 127.0.0.1 with port forwarding)"),
      port: z.number().default(2222).describe("SSH port"),
      username: z.string().describe("SSH username"),
      password: z.string().optional().describe("SSH password"),
      privateKey: z.string().optional().describe("SSH private key contents"),
      command: z.string().describe("Command to execute"),
      timeoutMs: z.number().default(30000).describe("Timeout in ms"),
    },
    async ({ host, port, username, password, privateKey, command, timeoutMs }) => {
      return new Promise((resolve) => {
        const conn = new SSHClient();
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          conn.end();
          resolve({ content: [{ type: "text", text: `SSH timeout after ${timeoutMs}ms.\nstdout: ${stdout}\nstderr: ${stderr}` }], isError: true });
        }, timeoutMs);

        conn.on("ready", () => {
          conn.exec(command, (err, stream) => {
            if (err) {
              clearTimeout(timer);
              conn.end();
              resolve({ content: [{ type: "text", text: `SSH exec error: ${err.message}` }], isError: true });
              return;
            }
            stream.on("data", (data: Buffer) => { stdout += data.toString(); });
            stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
            stream.on("close", (code: number | null) => {
              clearTimeout(timer);
              conn.end();
              const output = [
                `Exit code: ${code}`,
                stdout ? `stdout:\n${stdout}` : "",
                stderr ? `stderr:\n${stderr}` : "",
              ].filter(Boolean).join("\n");
              resolve({ content: [{ type: "text", text: output }] });
            });
          });
        }).on("error", (err) => {
          clearTimeout(timer);
          resolve({ content: [{ type: "text", text: `SSH connection error: ${err.message}` }], isError: true });
        }).connect({
          host, port, username,
          ...(password ? { password } : {}),
          ...(privateKey ? { privateKey } : {}),
          readyTimeout: timeoutMs,
          hostVerifier: () => true,
        });
      });
    },
  );

  server.tool(
    "vm_exec_winrm",
    "Execute a command on a Windows guest via WinRM (SOAP/HTTP, Basic auth)",
    {
      host: z.string().default("127.0.0.1").describe("WinRM host"),
      port: z.number().default(5985).describe("WinRM HTTP port"),
      username: z.string().describe("Windows username"),
      password: z.string().describe("Windows password"),
      command: z.string().describe("Command to execute (cmd.exe)"),
      usePowershell: z.boolean().default(false).describe("Execute as PowerShell command"),
      timeoutMs: z.number().default(30000).describe("Timeout in ms"),
    },
    async ({ host, port, username, password, command, usePowershell, timeoutMs }) => {
      const url = `http://${host}:${port}/wsman`;
      const auth = Buffer.from(`${username}:${password}`).toString("base64");

      const shellId = await winrmCreateShell(url, auth, timeoutMs);
      try {
        const actualCommand = usePowershell
          ? `powershell.exe -EncodedCommand ${Buffer.from(command, "utf16le").toString("base64")}`
          : command;

        const commandId = await winrmExecuteCommand(url, auth, shellId, actualCommand, timeoutMs);
        const result = await winrmReceiveOutput(url, auth, shellId, commandId, timeoutMs);
        return { content: [{ type: "text", text: result }] };
      } finally {
        await winrmDeleteShell(url, auth, shellId, timeoutMs).catch(() => {});
      }
    },
  );

  server.tool(
    "vm_get_guest_ip",
    "Get the guest IP address via VirtualBox guest properties",
    { vm: z.string().describe("VM name or UUID") },
    async ({ vm }) => {
      try {
        const output = await vboxManage("guestproperty", "enumerate", vm, "--patterns", "/VirtualBox/GuestInfo/Net/*/V4/IP");
        const ips: string[] = [];
        for (const line of output.split("\n")) {
          const match = line.match(/value:\s+(\d+\.\d+\.\d+\.\d+)/);
          if (match && match[1] !== "0.0.0.0") ips.push(match[1]);
        }
        if (ips.length === 0) {
          return { content: [{ type: "text", text: "No guest IP found. Guest Additions may not be running or network not ready." }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(ips) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Failed to get guest IP: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "vm_wait_for_guest_additions",
    "Wait until Guest Additions are running (polls GuestAdditionsRunLevel)",
    {
      vm: z.string().describe("VM name or UUID"),
      timeoutMs: z.number().default(120000).describe("Timeout in ms"),
      pollIntervalMs: z.number().default(3000).describe("Poll interval in ms"),
    },
    async ({ vm, timeoutMs, pollIntervalMs }) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const output = await vboxManage("showvminfo", vm, "--machinereadable");
          const info = parseMachineReadable(output);
          const level = parseInt(info["GuestAdditionsRunLevel"] || "0", 10);
          if (level >= 2) {
            return { content: [{ type: "text", text: `Guest Additions running (level ${level}).` }] };
          }
        } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, pollIntervalMs));
      }
      return { content: [{ type: "text", text: `Timeout waiting for Guest Additions after ${timeoutMs}ms.` }], isError: true };
    },
  );

  server.tool(
    "vm_wait_for_network",
    "Wait until the guest has a valid IP address",
    {
      vm: z.string().describe("VM name or UUID"),
      timeoutMs: z.number().default(120000).describe("Timeout in ms"),
      pollIntervalMs: z.number().default(3000).describe("Poll interval in ms"),
    },
    async ({ vm, timeoutMs, pollIntervalMs }) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const output = await vboxManage("guestproperty", "enumerate", vm, "--patterns", "/VirtualBox/GuestInfo/Net/*/V4/IP");
          for (const line of output.split("\n")) {
            const match = line.match(/value:\s+(\d+\.\d+\.\d+\.\d+)/);
            if (match && match[1] !== "0.0.0.0") {
              return { content: [{ type: "text", text: `Network ready. Guest IP: ${match[1]}` }] };
            }
          }
        } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, pollIntervalMs));
      }
      return { content: [{ type: "text", text: `Timeout waiting for network after ${timeoutMs}ms.` }], isError: true };
    },
  );

  server.tool(
    "vm_add_nat_port_forward",
    "Add a NAT port forwarding rule to the VM",
    {
      vm: z.string().describe("VM name or UUID"),
      name: z.string().describe("Rule name (e.g. 'ssh', 'winrm')"),
      protocol: z.enum(["tcp", "udp"]).default("tcp"),
      hostPort: z.number().describe("Host port"),
      guestPort: z.number().describe("Guest port"),
      adapter: z.number().default(1).describe("Network adapter number (1-based)"),
    },
    async ({ vm, name, protocol, hostPort, guestPort, adapter }) => {
      const rule = `${name},${protocol},,${hostPort},,${guestPort}`;
      // Check if VM is running - use controlvm for running VMs, modifyvm for powered-off ones
      const info = await vboxManage("showvminfo", vm, "--machinereadable");
      const state = parseMachineReadable(info)["VMState"];
      if (state === "running" || state === "paused") {
        await vboxManage("controlvm", vm, `natpf${adapter}`, rule);
      } else {
        await vboxManage("modifyvm", vm, `--natpf${adapter}`, rule);
      }
      return { content: [{ type: "text", text: `NAT port forward added: ${name} ${protocol} host:${hostPort} → guest:${guestPort}` }] };
    },
  );
}

// WinRM SOAP helpers
const WINRM_NS = "http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd";
const SHELL_NS = "http://schemas.microsoft.com/wbem/wsman/1/windows/shell";
const SOAP_NS = "http://www.w3.org/2003/05/soap-envelope";
const ADDR_NS = "http://schemas.xmlsoap.org/ws/2004/08/addressing";

function soapEnvelope(url: string, action: string, body: string, resourceUri?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="${SOAP_NS}" xmlns:a="${ADDR_NS}" xmlns:w="${WINRM_NS}" xmlns:rsp="${SHELL_NS}">
  <s:Header>
    <a:To>${url}</a:To>
    <a:Action>${action}</a:Action>
    ${resourceUri ? `<w:ResourceURI>${resourceUri}</w:ResourceURI>` : ""}
    <w:MaxEnvelopeSize>512000</w:MaxEnvelopeSize>
    <w:OperationTimeout>PT60S</w:OperationTimeout>
  </s:Header>
  <s:Body>${body}</s:Body>
</s:Envelope>`;
}

async function winrmPost(url: string, auth: string, body: string, timeout: number): Promise<string> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/soap+xml;charset=UTF-8",
      "Authorization": `Basic ${auth}`,
    },
    body,
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) throw new Error(`WinRM HTTP ${resp.status}: ${await resp.text()}`);
  return resp.text();
}

async function winrmCreateShell(url: string, auth: string, timeout: number): Promise<string> {
  const body = `<rsp:Shell xmlns:rsp="${SHELL_NS}"><rsp:InputStreams>stdin</rsp:InputStreams><rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>`;
  const xml = soapEnvelope(url, "http://schemas.xmlsoap.org/ws/2004/09/transfer/Create", body, `${SHELL_NS}/cmd`);
  const resp = await winrmPost(url, auth, xml, timeout);
  const match = resp.match(/<rsp:ShellId>([^<]+)<\/rsp:ShellId>/);
  if (!match) throw new Error("Failed to create WinRM shell");
  return match[1];
}

async function winrmExecuteCommand(url: string, auth: string, shellId: string, command: string, timeout: number): Promise<string> {
  const body = `<rsp:CommandLine xmlns:rsp="${SHELL_NS}"><rsp:Command>${escapeXml(command)}</rsp:Command></rsp:CommandLine>`;
  const envelope = soapEnvelope(
    url,
    `${SHELL_NS}/Command`,
    body,
    `${SHELL_NS}/cmd`,
  ).replace("</s:Header>", `<w:SelectorSet><w:Selector Name="ShellId">${shellId}</w:Selector></w:SelectorSet></s:Header>`);
  const resp = await winrmPost(url, auth, envelope, timeout);
  const match = resp.match(/<rsp:CommandId>([^<]+)<\/rsp:CommandId>/);
  if (!match) throw new Error("Failed to execute WinRM command");
  return match[1];
}

async function winrmReceiveOutput(url: string, auth: string, shellId: string, commandId: string, timeout: number): Promise<string> {
  const body = `<rsp:Receive xmlns:rsp="${SHELL_NS}" SequenceId="0"><rsp:DesiredStream CommandId="${commandId}">stdout stderr</rsp:DesiredStream></rsp:Receive>`;
  const envelope = soapEnvelope(
    url,
    `${SHELL_NS}/Receive`,
    body,
    `${SHELL_NS}/cmd`,
  ).replace("</s:Header>", `<w:SelectorSet><w:Selector Name="ShellId">${shellId}</w:Selector></w:SelectorSet></s:Header>`);

  let stdout = "";
  let stderr = "";
  let done = false;
  const maxIterations = 100;
  const deadline = Date.now() + timeout;

  for (let i = 0; i < maxIterations && !done; i++) {
    if (Date.now() > deadline) {
      throw new Error(`WinRM receive timed out after ${timeout}ms`);
    }
    const resp = await winrmPost(url, auth, envelope, timeout);

    // Extract stdout streams
    const streamRegex = /<rsp:Stream\s+Name="(stdout|stderr)"[^>]*>([^<]*)<\/rsp:Stream>/g;
    let streamMatch;
    while ((streamMatch = streamRegex.exec(resp)) !== null) {
      const decoded = Buffer.from(streamMatch[2], "base64").toString("utf-8");
      if (streamMatch[1] === "stdout") stdout += decoded;
      else stderr += decoded;
    }

    if (resp.includes("CommandState State") && resp.includes("Done")) {
      done = true;
    }
  }

  if (!done) {
    throw new Error(`WinRM receive exceeded max iterations (${maxIterations})`);
  }

  const parts = [];
  if (stdout) parts.push(`stdout:\n${stdout}`);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  return parts.join("\n") || "(no output)";
}

async function winrmDeleteShell(url: string, auth: string, shellId: string, timeout: number): Promise<void> {
  const envelope = soapEnvelope(
    url,
    "http://schemas.xmlsoap.org/ws/2004/09/transfer/Delete",
    "",
    `${SHELL_NS}/cmd`,
  ).replace("</s:Header>", `<w:SelectorSet><w:Selector Name="ShellId">${shellId}</w:Selector></w:SelectorSet></s:Header>`);
  await winrmPost(url, auth, envelope, timeout);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
