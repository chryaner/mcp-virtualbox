import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { vboxManage, formatError } from "../vbox.js";
import { resolveScancodes, getAvailableKeys } from "../scancodes.js";
import { config } from "../types.js";

export function registerInputTools(server: McpServer) {
  server.tool(
    "vm_keyboard_scancode",
    "Send named key combinations as PS/2 scancodes (e.g. 'enter', 'ctrl+alt+delete', 'f8', 'tab'). Use this for special keys, shortcuts, and navigation.",
    {
      vm: z.string().describe("VM name or UUID"),
      keys: z.string().describe("Key combo like 'enter', 'tab', 'f8', 'ctrl+alt+delete', 'alt+f4', 'shift+a'"),
      count: z.number().default(1).describe("Number of times to send the key combo"),
      delayMs: z.number().default(50).describe("Delay in ms between repeated key presses"),
    },
    async ({ vm, keys, count, delayMs }) => {
      let codes: string[];
      try {
        codes = resolveScancodes(keys);
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${formatError(e)}\n\nAvailable keys: ${getAvailableKeys().join(", ")}` }],
          isError: true,
        };
      }

      for (let i = 0; i < count; i++) {
        await vboxManage("controlvm", vm, "keyboardputscancode", ...codes);
        if (i < count - 1 && delayMs > 0) {
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
      return { content: [{ type: "text", text: `Sent "${keys}" x${count} (scancodes: ${codes.join(" ")})` }] };
    },
  );

  server.tool(
    "vm_keyboard_type",
    "Type printable text string into the VM (uses keyboardputstring). For special keys use vm_keyboard_scancode instead.",
    {
      vm: z.string().describe("VM name or UUID"),
      text: z.string().describe("Text to type"),
    },
    async ({ vm, text }) => {
      // keyboardputstring has a length limit, send in chunks
      const chunkSize = 64;
      for (let i = 0; i < text.length; i += chunkSize) {
        const chunk = text.slice(i, i + chunkSize);
        await vboxManage("controlvm", vm, "keyboardputstring", chunk);
      }
      return { content: [{ type: "text", text: `Typed ${text.length} characters.` }] };
    },
  );

  server.tool(
    "vm_mouse_click",
    "Click at absolute screen coordinates (requires USB tablet mouse mode, enabled by vm_create). Coordinates match screenshot pixel positions. Uses Python VirtualBox API helper.",
    {
      vm: z.string().describe("VM name or UUID"),
      x: z.number().describe("X coordinate (pixels from left)"),
      y: z.number().describe("Y coordinate (pixels from top)"),
      button: z.enum(["left", "right", "middle"]).default("left").describe("Mouse button"),
      doubleClick: z.boolean().default(false).describe("Double click"),
    },
    async ({ vm, x, y, button, doubleClick }) => {
      return new Promise((resolve, reject) => {
        const args = [
          config.mouseHelperPath,
          vm,
          String(x),
          String(y),
          button,
        ];
        if (doubleClick) args.push("--double");

        execFile(config.pythonPath, args, { timeout: config.defaultTimeout }, (err, stdout, stderr) => {
          if (err) {
            resolve({
              content: [{ type: "text", text: `Mouse click failed: ${stderr || err.message}` }],
              isError: true,
            });
          } else {
            resolve({
              content: [{ type: "text", text: `Clicked ${button} at (${x}, ${y})${doubleClick ? " (double)" : ""}` }],
            });
          }
        });
      });
    },
  );
}
