# mcp-virtualbox

Let AI see, click, type, and fully operate virtual machines - from bare metal OS installation to daily use, no human needed.

## TL;DR

```json
{
  "mcpServers": {
    "mcp-virtualbox": {
      "command": "npx",
      "args": ["-y", "mcp-virtualbox"]
    }
  }
}
```

Add to `.mcp.json` (Claude Code) or `claude_desktop_config.json` (Claude Desktop). Requires [VirtualBox](https://www.virtualbox.org/) 7.x and [Node.js](https://nodejs.org/) 18+.

Provide your own OS installer ISO - just tell the AI where it is and what OS to install.

---

## What is this

An [MCP server](https://modelcontextprotocol.io/) that wraps VirtualBox, giving AI assistants 30 tools to create, install, and operate VMs through two modes:

1. **Vision loop** - screenshot, read screen, send keyboard/mouse. Works with any OS, any installer, any GUI.
2. **Text mode** - SSH, WinRM, or Guest Additions for fast command execution.

## How it works

```
vm_create("WindowsXP")          -> VM with correct settings (IDE, 512MB RAM)
vm_attach_media(iso)             -> Mount installer ISO
vm_install_guide("xp")           -> Step-by-step guide with gotchas
vm_screenshot()                  -> AI sees "Welcome to Setup"
vm_keyboard_scancode("enter")    -> AI presses Enter
  ... repeat until installed ...
vm_guest_exec("cmd.exe", ["/c", "dir"])  -> Text-based control
```

## Tools

30 tools across 6 categories:

| Category | Tools |
|----------|-------|
| **Lifecycle** (15) | `vm_list` `vm_info` `vm_create` `vm_start` `vm_stop` `vm_delete` `vm_pause` `vm_resume` `vm_reset` `vm_attach_media` `vm_snapshot` `vm_modify` `vm_list_ostypes` `vm_shared_folder_add` `vm_shared_folder_remove` |
| **Display** (2) | `vm_screenshot` `vm_screen_info` |
| **Input** (3) | `vm_keyboard_scancode` `vm_keyboard_type` `vm_mouse_click` |
| **Guest Control** (3) | `vm_guest_exec` `vm_guest_copy_to` `vm_guest_copy_from` |
| **Network** (6) | `vm_exec_ssh` `vm_exec_winrm` `vm_get_guest_ip` `vm_wait_for_guest_additions` `vm_wait_for_network` `vm_add_nat_port_forward` |
| **Knowledge** (1) | `vm_install_guide` |

## Testing status

|  | Windows XP | Windows 7/10/11 | Ubuntu/Linux |
|--|:--:|:--:|:--:|
| OS install (vision loop) | x | - | - |
| Guest Additions | x | - | - |
| Guest exec | x | - | - |
| SSH | - | - | - |
| WinRM | - | - | - |
| Screenshot + keyboard | x | - | - |
| Mouse click | x | - | - |

**Host platforms:** Windows x64 (tested), Linux/macOS (should work).

`x` = tested, `-` = should work, not yet verified

## Environment variables

| Variable | Default |
|----------|---------|
| `VBOXMANAGE_PATH` | Auto-detected |
| `VBOXMANAGE_DRY_RUN` | `false` |
| `VBOXMANAGE_DEBUG` | `false` |

## From source

```bash
git clone https://github.com/chryaner/mcp-virtualbox.git
cd mcp-virtualbox
npm install && npm run build
```

Python 3 with `vboxapi` module is optional (only needed for `vm_mouse_click`).

## License

MIT
