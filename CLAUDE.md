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
    ├── input.ts          # Input: keyboard_scancode, keyboard_type, mouse_click
    ├── guest-control.ts  # Guest Additions: guest_exec, guest_copy_to, guest_copy_from
    ├── network-exec.ts   # Network: exec_ssh, exec_winrm, get_guest_ip, wait_for_guest_additions,
    │                     #   wait_for_network, add_nat_port_forward
    └── knowledge.ts      # Install guides: vm_install_guide (XP, 7, 10/11, Ubuntu)
scripts/
└── mouse_click.py        # Python helper for absolute mouse via VirtualBox API (vboxapi)
```

**Key invariant:** Every VBoxManage call must go through `vbox.ts`. Never call `child_process` directly from tool files - the wrapper handles error formatting, timeout, and `\r\n` normalization.

---

## Tool Categories (30 tools)

| Category | Count | Tools |
|----------|-------|-------|
| Lifecycle | 15 | vm_list, vm_info, vm_create, vm_start, vm_stop, vm_delete, vm_pause, vm_resume, vm_reset, vm_attach_media, vm_snapshot, vm_modify, vm_list_ostypes, vm_shared_folder_add, vm_shared_folder_remove |
| Display | 2 | vm_screenshot, vm_screen_info |
| Input | 3 | vm_keyboard_scancode, vm_keyboard_type, vm_mouse_click |
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
7. **Mouse via Python helper** - VBoxManage has no CLI mouse command; uses `vboxapi` Python bindings
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

#### Host Platforms
- [x] Windows (x64) - primary dev, all tools verified
- [ ] Linux (x86_64) - VBoxManage path detection, SSH, screenshot, mouse helper
- [ ] macOS (Intel / Apple Silicon)

#### Guest OS Installation (full vision-loop install + Guest Additions + text control)
- [x] Windows XP 32-bit - IDE controller, legacy OS defaults, guest exec with password
- [ ] Windows XP 64-bit
- [ ] Windows 7
- [ ] Windows 10
- [ ] Windows 11
- [ ] Ubuntu / Debian
- [ ] Fedora / RHEL

#### Tool Coverage (manual verification)
- [x] vm_list, vm_info, vm_create, vm_start, vm_stop
- [x] vm_attach_media (ISO attach + eject)
- [x] vm_screenshot, vm_screen_info
- [x] vm_keyboard_scancode, vm_keyboard_type
- [x] vm_mouse_click (path fixed; needs vboxapi Python module)
- [x] vm_guest_exec (with password set)
- [x] vm_install_guide
- [x] vm_delete
- [x] vm_pause, vm_resume, vm_reset
- [x] vm_snapshot (take / restore / delete / list)
- [x] vm_modify
- [x] vm_shared_folder_add, vm_shared_folder_remove (persistent + transient)
- [x] vm_get_guest_ip, vm_wait_for_guest_additions (timeout path verified)
- [x] vm_add_nat_port_forward (auto-detects running vs off state)
- [x] vm_list_ostypes
- [ ] vm_guest_copy_to, vm_guest_copy_from (needs Guest Additions in guest)
- [ ] vm_exec_ssh (needs SSH server in guest)
- [ ] vm_exec_winrm (needs WinRM enabled in Windows guest)
- [ ] vm_wait_for_network (needs Guest Additions; timeout path verified)

#### Edge Cases
- [ ] VM with spaces in name
- [ ] Multiple VMs running simultaneously
- [ ] Snapshot restore while VM is running
- [ ] Guest exec with arguments containing special characters
- [ ] Screenshot when VM is paused
- [ ] Large file copy via guest_copy_to/from
- [ ] SSH with key-based auth (no password)
- [ ] WinRM with PowerShell command (`usePowershell: true`)
- [ ] Dry-run mode (`VBOXMANAGE_DRY_RUN=true`) - verify no side effects
- [ ] Auto-detect VBoxManage from PATH when not in standard location
