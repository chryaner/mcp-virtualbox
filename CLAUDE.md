# CLAUDE.md - VirtualBox MCP Server

This file guides Claude Code when working in this repository. Read it fully before making any changes.

---

## Project Overview

This is a **TypeScript MCP (Model Context Protocol) server** that gives AI assistants full control over Oracle VirtualBox VMs. It wraps `VBoxManage` CLI calls and surfaces them as structured MCP tools. Supports a vision-loop workflow (screenshot + keyboard/mouse) for OS installation, then switches to efficient text-based control (Guest Additions / SSH / WinRM) once the OS is running.

**Package name:** `mcp-virtualbox`
**Entry point:** `dist/index.js`
**Runtime:** Node.js 18+
**Transport:** stdio

---

## Architecture

```
src/
├── index.ts              # MCP server bootstrap, transport setup (stdio), tool registration
├── vbox.ts               # VBoxManage CLI wrapper (execFile + output parsing)
├── scancodes.ts          # PS/2 Set 1 scancode lookup tables for keyboard input
├── types.ts              # Config, VBoxManage path auto-detection, shared interfaces
└── tools/
    ├── lifecycle.ts      # VM lifecycle: list, info, create, start, stop, delete, pause, resume, reset,
    │                     #   attach_media, snapshot, modify, list_ostypes, shared_folder_add/remove
    ├── display.ts        # Vision: screenshot (→ base64 PNG), screen_info
    ├── input.ts          # Input: keyboard_scancode, keyboard_type, mouse_click, mouse_move,
    │                     #   mouse_scroll, mouse_drag
    ├── guest-control.ts  # Guest Additions: guest_exec, guest_copy_to, guest_copy_from
    ├── network-exec.ts   # Network: exec_ssh, exec_winrm, get_guest_ip, wait_for_guest_additions,
    │                     #   wait_for_network, add_nat_port_forward
    └── knowledge.ts      # Install guides: vm_install_guide (XP, 7, 10/11, Ubuntu)
scripts/
└── mouse_click.py        # Fallback for vm_mouse_click only, where vboxwebsrv will not start
```

**Key invariant:** Every VBoxManage call must go through `vbox.ts`. Never call `child_process` directly from tool files - the wrapper handles error formatting, timeout, and `\r\n` normalization.

---

## Tool Categories (33 tools)

| Category | Count | Tools |
|----------|-------|-------|
| Lifecycle | 15 | vm_list, vm_info, vm_create, vm_start, vm_stop, vm_delete, vm_pause, vm_resume, vm_reset, vm_attach_media, vm_snapshot, vm_modify, vm_list_ostypes, vm_shared_folder_add, vm_shared_folder_remove |
| Display | 2 | vm_screenshot, vm_screen_info |
| Input | 6 | vm_keyboard_scancode, vm_keyboard_type, vm_mouse_click, vm_mouse_move, vm_mouse_scroll, vm_mouse_drag |
| Guest Control | 3 | vm_guest_exec, vm_guest_copy_to, vm_guest_copy_from |
| Network Exec | 6 | vm_exec_ssh, vm_exec_winrm, vm_get_guest_ip, vm_wait_for_guest_additions, vm_wait_for_network, vm_add_nat_port_forward |
| Knowledge | 1 | vm_install_guide |

---

## MCP Tool Conventions

### Naming
- All tool names use **snake_case** with `vm_` prefix
- Keep names under 32 characters

### Input Schemas
- Define all inputs using **Zod schemas** inline in tool registration
- Every parameter must have a `.describe()` annotation - these appear in LLM context and matter for usability
- UUIDs and VM names should both be accepted wherever VBoxManage supports either
- Default values should match VirtualBox defaults to avoid surprises

### Output Format
- Return `{ content: [{ type: "text", text: ... }] }` for text results
- Return `{ content: [{ type: "image", data: base64, mimeType: "image/png" }] }` for screenshots
- On error: set `isError: true` with a human-readable message
- Never let raw VBoxManage stderr leak to the MCP caller unformatted

### Error Handling
- Catch all `VBoxManage` errors in the wrapper and format them consistently
- If a VM is in a state that prevents the operation, say so clearly
- Tools that poll (wait_for_guest_additions, wait_for_network) must have timeouts

---

## VBoxManage Wrapper (`src/vbox.ts`)

This is the most critical file. Rules:

- All commands run via `child_process.execFile` (not `exec`) to avoid shell injection
- Always normalize `\r\n` → `\n` in stdout (Windows VBoxManage outputs CRLF)
- `parseMachineReadable()` handles `key="value"` format with backslash unescaping
- `parseVMList()` handles `"name" {uuid}` format
- Always pass `--machinereadable` flag where available for consistent parsing

---

## Key Design Decisions

1. **VBoxManage CLI only** - no COM/XPCOM bindings, everything via `execFile`
2. **Auto-detect VBoxManage path** - checks common install locations on Windows/Linux/macOS, falls back to PATH
3. **USB tablet mouse** - `--mouse=usbtablet` on VM create enables absolute mouse positioning matching screenshot pixel coords
4. **Legacy OS detection** - vm_create auto-detects XP/2000/98/DOS and uses IDE instead of SATA (no AHCI drivers)
5. **OS-aware defaults** - RAM/CPU/disk auto-selected based on OS type
6. **PS/2 scancode table** - full Set 1 map with combo support (`ctrl+alt+delete`)
7. **Mouse via the VirtualBox web service** - VBoxManage has no CLI mouse command, so `src/webservice.ts` starts `vboxwebsrv` (it ships with every VirtualBox) on a loopback port with a per-process password and sends SOAP calls to `IMouse`. Button changes are spaced 120 ms apart: at 50 ms a Linux guest dropped half the clicks
8. **WinRM without dependency** - raw SOAP/XML POST to port 5985 with Basic auth
9. **Install guides as a tool** - `vm_install_guide` returns step-by-step instructions with gotchas so the AI agent doesn't repeat known mistakes

---

## Critical Gotchas (embedded in tools + install guides)

| Gotcha | Where it's documented |
|--------|----------------------|
| Windows XP/2000 have NO SATA drivers - must use IDE | vm_create auto-handles; vm_install_guide |
| Windows accounts with blank passwords can't use guestcontrol | vm_guest_exec description; vm_install_guide |
| VBoxManage guestcontrol breaks args with spaces | vm_guest_exec args description; install guide |
| VBoxManage outputs `\r\n` on Windows | Fixed in vbox.ts wrapper |
| VBoxManage `--machinereadable` uses `\\` escaped backslashes | Fixed in parseMachineReadable |

---

## Supported Platforms

- **Windows** (x64) - primary development platform
- **Linux** (x86_64) - supported, auto-detects VBoxManage in /usr/bin, /usr/local/bin, /opt/VirtualBox
- **macOS** (Intel + Apple Silicon) - should work, not yet tested
- VirtualBox 7.x required
- The server process runs as the current user (must be in `vboxusers` group on Linux)

---

## Build & Dev

```bash
npm install          # Install dependencies
npm run build        # tsc → dist/
npm run dev          # tsc --watch
npm start            # node dist/index.js
```

### MCP Client Configuration

```json
{
  "mcpServers": {
    "mcp-virtualbox": {
      "command": "node",
      "args": ["/path/to/vm-mcp/dist/index.js"]
    }
  }
}
```

Or with env var override:
```json
{
  "mcpServers": {
    "mcp-virtualbox": {
      "command": "node",
      "args": ["/path/to/vm-mcp/dist/index.js"],
      "env": {
        "VBOXMANAGE_PATH": "/custom/path/to/VBoxManage"
      }
    }
  }
}
```

---

## Security Considerations

- **Never** pass user-supplied strings directly to shell - always use `execFile` with argument arrays
- VM names and UUIDs are validated via Zod schemas before use
- SSH `hostVerifier` is disabled (returns true) - acceptable for local NAT VMs only
- WinRM uses plain HTTP with Basic auth - credentials are unencrypted on the wire
- The MCP server runs with the permissions of the invoking user

---

## Testing

Three layers, and a change to a tool should keep all three passing:

- `npm test` - unit tests with VBoxManage mocked. Fast; they pin command lines and parsing, and
  prove nothing about VirtualBox itself.
- `npm run smoke` - starts the built server and speaks MCP to it: handshake, tool count, a
  description on every parameter. Needs no VirtualBox.
- `npm run e2e` - `test/e2e.mjs` drives the tools against a real VM (Ubuntu) and checks each by its
  effect inside the guest. `test/e2e-windows.mjs` does the same against an installed Windows.
  The header of each file lists the environment variables it needs.

CI runs the first two on Linux, Windows and macOS (`ci.yml`) and the Ubuntu end-to-end on a Linux
runner (`e2e.yml`). The table of what has been verified against which guest is in README.md:
update it when a run changes it, and never mark a cell from memory.

Things the end-to-end runs taught that are not visible in the code:

- VirtualBox 7 changed several output formats and argument rules from 6 (guest properties, copy
  destinations, where "no snapshots" is printed). Mocked tests did not notice for a year.
- Under nested virtualization a guest sometimes hangs in the first seconds of boot; `vm_reset` fixes it.
- Guest Additions must match the host's version, or guest control cannot start a session.
- VirtualBox 7.2.22 on a Linux host often returns no stdout from a guest command that exits at once.
- A mouse button needs about 100 ms down, and 100 ms up, for a guest to register it.
