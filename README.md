# mcp-virtualbox

[![ci](https://github.com/chryaner/mcp-virtualbox/actions/workflows/ci.yml/badge.svg)](https://github.com/chryaner/mcp-virtualbox/actions/workflows/ci.yml)
[![e2e](https://github.com/chryaner/mcp-virtualbox/actions/workflows/e2e.yml/badge.svg)](https://github.com/chryaner/mcp-virtualbox/actions/workflows/e2e.yml)
[![npm](https://img.shields.io/npm/v/mcp-virtualbox)](https://www.npmjs.com/package/mcp-virtualbox)
[![does it install](https://img.shields.io/endpoint?url=https://doesitinstall.com/badge/seed__mcp-virtualbox.json)](https://doesitinstall.com/s/seed__mcp-virtualbox.html)

An [MCP server](https://modelcontextprotocol.io/) that lets an AI assistant see, click, type in and fully operate VirtualBox virtual machines: from installing an operating system on bare metal to daily use, with no human at the keyboard.

## Install

### Claude Code

```
/plugin marketplace add chryaner/mcp-virtualbox
/plugin install mcp-virtualbox@mcp-virtualbox
```

### Claude Desktop and other MCP clients

Add to `.mcp.json` or `claude_desktop_config.json`:

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

Requires [VirtualBox](https://www.virtualbox.org/) 7.x and [Node.js](https://nodejs.org/) 18 or later. Nothing else: no Python, no Guest Additions on the host, no configuration.

Bring your own installer ISO. Tell the assistant where it is and what to install.

## What it does

33 tools, used in two ways:

1. **Vision loop.** Take a screenshot, read the screen, send keys and mouse events, repeat. It works with any operating system, any installer and any GUI, because it needs nothing inside the guest.
2. **Text mode.** Once the guest runs, execute commands in it over SSH, WinRM or VirtualBox Guest Additions, which is faster and exact.

```
vm_create("WindowsXP")                   -> a VM with settings that OS can boot from (IDE, 512 MB)
vm_attach_media(iso)                     -> installer in the drive
vm_install_guide("xp")                   -> the steps, and the traps
vm_screenshot()                          -> the assistant sees "Welcome to Setup"
vm_keyboard_scancode("enter")            -> and presses Enter
  ... until installed ...
vm_guest_exec("cmd.exe", ["/c", "dir"])  -> text from here on
```

## Tools

| Category | Tools |
|----------|-------|
| **Lifecycle** (15) | `vm_list` `vm_info` `vm_create` `vm_start` `vm_stop` `vm_delete` `vm_pause` `vm_resume` `vm_reset` `vm_attach_media` `vm_snapshot` `vm_modify` `vm_list_ostypes` `vm_shared_folder_add` `vm_shared_folder_remove` |
| **Display** (2) | `vm_screenshot` `vm_screen_info` |
| **Input** (6) | `vm_keyboard_scancode` `vm_keyboard_type` `vm_mouse_click` `vm_mouse_move` `vm_mouse_scroll` `vm_mouse_drag` |
| **Guest Control** (3) | `vm_guest_exec` `vm_guest_copy_to` `vm_guest_copy_from` |
| **Network** (6) | `vm_exec_ssh` `vm_exec_winrm` `vm_get_guest_ip` `vm_wait_for_guest_additions` `vm_wait_for_network` `vm_add_nat_port_forward` |
| **Knowledge** (1) | `vm_install_guide` |

Mouse coordinates are screenshot pixels: `(0, 0)` is the top-left corner of what `vm_screenshot` returns.

## What has been tested

Every row is checked by its effect inside the guest, not by the tool saying it worked: typed text is read back from the guest, a click by the input event the guest receives or the menu it opens, a copied file by its SHA-256.

|  | Ubuntu 24.04 | Windows 11 | Windows 10 | Windows 7 | Windows XP |
|--|:--:|:--:|:--:|:--:|:--:|
| Create, attach a disk, start, stop, delete | ✅ | ✅ | ✅ | ✅ | ✅ |
| Modify, pause, resume, reset, snapshots | ✅ | · | · | · | · |
| Port forwarding | ✅ | ✅ | ✅ | · | · |
| Screenshot | ✅ | ✅ | ✅ | ✅ | ✅ |
| Keyboard | ✅ | ✅ | ✅ | ✅ | ✅ |
| Mouse click | ✅ | ✅ | ✅ | ✅ | ✅ |
| Mouse move, scroll, drag | ✅ | · | · | · | · |
| Guest Additions: wait, network, IP | ✅ | ✅ | ✅ | ✅ | ✅ |
| Guest exec, copy to and from | ✅ | ✅ | ✅ | ✅ | ✅ |
| Shared folder | ✅ | ❌ | ❌ | ❌ | · |
| SSH | ✅ | ✅ | ✅ | · | · |
| WinRM | n/a | ✅ | ✅ | · | · |
| OS install by vision loop | · | · | · | · | ✅ |

✅ verified, ❌ tried and failed, · not tried.

- **Ubuntu** runs on every pull request that touches the server ([`e2e.yml`](.github/workflows/e2e.yml), `test/e2e.mjs`) on a Linux host with VirtualBox 7.2.22, and was run by hand on a Windows 11 host with 7.2.0.
- **Windows 11, 10 and 7** were run by hand with `test/e2e-windows.mjs` on a Windows 11 host with VirtualBox 7.2.0, against installed guests.
- **Windows XP** was installed and operated through the vision loop by hand, on version 1.0.
- **Shared folder on Windows guests:** VirtualBox shows the share attached, and the guest answers "the network name cannot be found". Not understood yet.
- **macOS hosts:** the unit tests run there; nothing has driven a real VM.

## When something goes wrong

- **A guest that never finishes booting.** Under nested virtualization (a cloud VM, or Windows with Hyper-V, WSL2 or Docker Desktop switched on) a guest sometimes stops in the first seconds of its boot and never recovers. The screenshot shows a kernel log that has stopped, with a clock that is not advancing. `vm_reset` and it boots.
- **Guest Additions must match the host.** `vm_guest_exec` between a 7.2 host and a guest with a distribution's 7.0 additions fails to start a session. Install them from the host's own ISO: `vm_attach_media` with `medium: "additions"`.
- **`vm_guest_exec` returns no output on a Linux host.** VirtualBox 7.2.22 on Linux often loses the output of a guest command that exits at once, from `VBoxManage` in a shell too. The command still runs. Redirect its output to a file in the guest and fetch that with `vm_guest_copy_from`, or use `vm_exec_ssh`.
- **Windows refuses a Guest Additions login.** An account with a blank password cannot be used; set one.
- **A click does nothing.** Absolute positions need a USB tablet as the pointing device. `vm_create` sets that up; for a VM made elsewhere, power it off and run `vm_modify` with `["--mouse", "usbtablet"]`.

## Environment variables

| Variable | Default | |
|----------|---------|--|
| `VBOXMANAGE_PATH` | found automatically | Path to `VBoxManage` |
| `VBOXWEBSRV_PATH` | next to `VBoxManage` | Path to `vboxwebsrv`, which the mouse tools use |
| `VBOXMANAGE_DRY_RUN` | `false` | Log commands instead of running them |
| `VBOXMANAGE_DEBUG` | `false` | Log every command to stderr |
| `SCREENSHOT_DIR` | the temp directory | Where screenshots are written before they are returned |
| `DEFAULT_TIMEOUT` | `30000` | Milliseconds |

## Development

```bash
git clone https://github.com/chryaner/mcp-virtualbox.git
cd mcp-virtualbox
npm install
npm run build
npm test          # unit tests, VBoxManage mocked
npm run smoke     # start the built server and speak MCP to it
npm run e2e       # every tool against a real VM; see the top of test/e2e.mjs
```

The mouse tools talk to the web service that ships with VirtualBox (`vboxwebsrv`). The server starts one for itself on a loopback port, with a user name and password made up for that one process.

## Related

[terrarium](https://github.com/chryaner/terrarium) grew out of this project and took a different shape: golden images, forks in seconds, revert to clean, and a CLI beside its MCP server. Use it when you want disposable environments. Use mcp-virtualbox when you want direct control of a VirtualBox VM: creating one from nothing, installing an OS from an ISO, changing any setting.

## License

MIT
