# Changelog

## 1.1.0

The first release that has been run, tool by tool, against real virtual machines. That found ten
bugs, most of them tools that had never worked on VirtualBox 7.

### Added

- `vm_mouse_move`, `vm_mouse_scroll` and `vm_mouse_drag`: hover, turn the wheel, and press-move-release.
- `vm_install_guide` ends with a section on what goes wrong with any guest and what to do about it.

### Changed

- The mouse no longer needs Python. `vm_mouse_click` used a helper script and VirtualBox's Python
  bindings, which most installations do not have and the Linux packages do not install. The mouse
  tools now talk to the web service that ships with VirtualBox (`vboxwebsrv`): the server starts it
  on a loopback port, with a user name and password made up for that one process. The Python helper
  is still tried if the web service will not start.
- `vm_exec_winrm` output starts with the command's exit code.

### Security

- `@modelcontextprotocol/sdk` 1.27 to 1.32 and `zod` 3 to 4, which clears every advisory `npm audit`
  reported, in the SDK itself and in the `hono`, `body-parser`, `path-to-regexp` and `zod` it pulls in.
- A failed VBoxManage call with nothing on stderr no longer puts its whole command line into the
  error text. For the guest control tools that line includes the guest password.

### Fixed

Tools that did not work on VirtualBox 7:

- `vm_wait_for_network` always timed out and `vm_get_guest_ip` never found an address. VirtualBox 7
  prints guest properties as `name = 'value' @ time`; the tools only read the VirtualBox 6 format.
  Both are read now.
- `vm_guest_copy_to` and `vm_guest_copy_from` failed with "already exists and is a directory" when
  given a directory as the destination. VirtualBox 7 takes a destination as a directory only if it
  ends in a path separator. A directory is accepted with or without one, and a full file path still
  names the file to write.
- `vm_snapshot` with `action: "list"` returned an error for a VM with no snapshots instead of
  "No snapshots.". VirtualBox reports that on stdout, which the wrapper did not read.
- `vm_attach_media` with `medium: "additions"` failed with "Could not find file" on a slot with no
  DVD drive in it yet, which is every slot of a VM `vm_create` just made. VBoxManage only
  understands the word where a drive exists, so the tool puts an empty drive in first.

Tools that did not work at all:

- `vm_exec_winrm`. Windows refused every request (HTTP 500, "invalid SOAP headers") for want of a
  `MessageID` and a `ReplyTo`; and the tool never saw a command finish, so it asked for output
  again and got "The operation was canceled by the user". A PowerShell command no longer puts
  progress records on stderr.

The mouse:

- `vm_mouse_click` lost about half its clicks on a Linux guest: the press and the release were
  50 ms apart, and the guest saw the pointer move with no button at all. Button changes are now
  120 ms apart; 18 of 18 clicks arrived in the same test.
- `vm_mouse_click` clicked one pixel up and to the left of the screenshot pixel asked for.

Smaller:

- The wrapper left VBoxManage's stdin open as a pipe that never ends.
- `vm_add_nat_port_forward`: the `protocol` parameter now has a description, like every other
  parameter.

### Documentation

- The README says what has been tested against which guest, from actual runs: Ubuntu 24.04,
  Windows 11, 10 and 7. It has a section on what goes wrong and what to do.

### Development

- CI on Linux, Windows and macOS with Node 20, 22 and 24: build, unit tests, and a smoke test that
  starts the built server and speaks MCP to it. A second job installs the packed tarball on Node 18
  and starts it, and a third fails on any high-severity advisory.
- `npm run e2e` drives 31 of the 33 tools through MCP against a real VirtualBox: it creates a VM,
  boots Ubuntu, and checks each tool's effect inside the guest. It runs on a Linux runner weekly
  and on pull requests that touch the server. `npm run e2e:windows` does the same against an
  installed Windows guest.
- TypeScript 7 and vitest 5.
- `release.yml` publishes a pushed tag to npm with provenance and as a GitHub release.

## 1.0.1

### Fixed

- `vm_keyboard_type` no longer drops characters on long strings. Chunks are now sent
  with a small inter-chunk delay so the guest keyboard buffer can drain. Added optional
  `chunkSize` (default 50) and `delayMs` (default 30) parameters.

### Added

- `vm_keyboard_scancode` now supports numeric-keypad keys: `kp_0`–`kp_9`, `kp_enter`,
  `kp_dot`, `kp_plus`, `kp_minus`, `kp_star`/`kp_multiply`, `kp_slash`/`kp_divide`.
  Needed for installers that accept only the keypad.
- `vm_keyboard_scancode` `raw` parameter to send arbitrary PS/2 Set 1 make/break bytes
  as space-separated hex, for keys not covered by the named map.

## 1.0.0

Initial release.

### Features

- 30 MCP tools for complete VirtualBox VM control
- Vision loop support (screenshot + keyboard/mouse input)
- Text-based control via SSH, WinRM, and Guest Additions
- Smart OS defaults - auto-detects legacy OS types and configures IDE/SATA accordingly
- Built-in install guides for Windows XP, 7, 10/11, and Ubuntu/Linux
- PS/2 scancode keyboard input with combo support (ctrl+alt+delete, etc.)
- Absolute mouse positioning via Python VirtualBox API helper
- WinRM support via raw SOAP/HTTP (no extra dependencies)
- NAT port forwarding management
- Shared folder management
- Snapshot management (take/restore/delete/list)
- Cross-platform VBoxManage path auto-detection
- Dry-run mode and debug logging via environment variables
- Structured error handling with VBox error codes
