# Changelog

## 1.0.2

### Security

- `@modelcontextprotocol/sdk` 1.27 to 1.32 and `zod` 3 to 4, which clears every advisory `npm audit`
  reported, in the SDK itself and in the `hono`, `body-parser`, `path-to-regexp` and `zod` it pulls in.
  The tools and their input schemas are unchanged.

### Fixed

- `vm_add_nat_port_forward`: the `protocol` parameter now has a description, like every other
  parameter.

### Development

- CI on Linux, Windows and macOS with Node 20, 22 and 24: build, unit tests, and a smoke test that
  starts the built server and speaks MCP to it. A second job installs the packed tarball on Node 18
  and starts it, and a third fails on any high-severity advisory.

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
