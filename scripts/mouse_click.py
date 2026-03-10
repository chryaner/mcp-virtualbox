#!/usr/bin/env python3
"""
Absolute mouse click helper for VirtualBox VMs.
Uses the VirtualBox Python API (vboxapi) for absolute mouse positioning,
which requires USB tablet mouse mode on the VM.

Usage: python mouse_click.py <vm_name> <x> <y> [left|right|middle] [--double]
"""

import sys
import time

def main():
    if len(sys.argv) < 4:
        print("Usage: mouse_click.py <vm_name> <x> <y> [left|right|middle] [--double]", file=sys.stderr)
        sys.exit(1)

    vm_name = sys.argv[1]
    x = int(sys.argv[2])
    y = int(sys.argv[3])
    button = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != "--double" else "left"
    double = "--double" in sys.argv

    button_map = {"left": 0x01, "right": 0x02, "middle": 0x04}
    button_flag = button_map.get(button, 0x01)

    try:
        import vboxapi
    except ImportError:
        # Fallback: try importing from VirtualBox SDK location
        import os
        vbox_path = os.environ.get("VBOX_SDK_PATH", r"C:\Program Files\Oracle\VirtualBox\sdk\install")
        sys.path.insert(0, vbox_path)
        import vboxapi

    mgr = vboxapi.VirtualBoxManager(None, None)
    vbox = mgr.getVirtualBox()
    machine = vbox.findMachine(vm_name)
    session = mgr.getSessionObject()

    machine.lockMachine(session, 1)  # LockType_Shared = 1
    try:
        console = session.console
        mouse = console.mouse

        if not mouse.absoluteSupported:
            print("Warning: Absolute mouse not supported. Enable USB tablet mode.", file=sys.stderr)

        # Move to position and click
        mouse.putMouseEventAbsolute(x, y, 0, 0, button_flag)
        time.sleep(0.05)
        mouse.putMouseEventAbsolute(x, y, 0, 0, 0)  # Release

        if double:
            time.sleep(0.1)
            mouse.putMouseEventAbsolute(x, y, 0, 0, button_flag)
            time.sleep(0.05)
            mouse.putMouseEventAbsolute(x, y, 0, 0, 0)

        print(f"Clicked {button} at ({x}, {y})" + (" (double)" if double else ""))
    finally:
        session.unlockMachine()

if __name__ == "__main__":
    main()
