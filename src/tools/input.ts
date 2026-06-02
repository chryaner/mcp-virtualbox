import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { vboxManage, formatError } from "../vbox.js";
import { resolveScancodes, getAvailableKeys } from "../scancodes.js";
import { config } from "../types.js";

export function registerInputTools(server: McpServer) {
  server.tool(
    "vm_keyboard_scancode",
    "Send named key combinations as PS/2 scancodes (e.g. 'enter', 'ctrl+alt+delete', 'f8', 'tab'). Use this for special keys, shortcuts, and navigation. Numeric-keypad keys are available as kp_0..kp_9, kp_enter, kp_dot, kp_plus, kp_minus, kp_star, kp_slash. For keys not in the named map, pass raw make/break bytes via 'raw'.",
    {
      vm: z.string().describe("VM name or UUID"),
      keys: z.string().optional().describe("Key combo like 'enter', 'tab', 'f8', 'ctrl+alt+delete', 'alt+f4', 'shift+a', 'kp_1'. Either 'keys' or 'raw' must be provided."),
      raw: z.string().optional().describe("Raw PS/2 Set 1 scancode bytes as space-separated hex, sent verbatim (e.g. '4f cf' for keypad-1 make+break). Include both make and break bytes. Use when a key is not in the named map. Takes precedence over 'keys'."),
      count: z.number().default(1).describe("Number of times to send the key combo"),
      delayMs: z.number().default(50).describe("Delay in ms between repeated key presses"),
    },
    async ({ vm, keys, raw, count, delayMs }) => {
      let codes: string[];
      if (raw !== undefined) {
        codes = raw.trim().split(/\s+/).filter(Boolean).map(b => b.toLowerCase());
        const bad = codes.find(b => !/^[0-9a-f]{1,2}$/.test(b));
        if (codes.length === 0 || bad) {
          return {
            content: [{ type: "text", text: `Error: 'raw' must be space-separated hex bytes (e.g. '4f cf').${bad ? ` Invalid byte: "${bad}"` : ""}` }],
            isError: true,
          };
        }
        codes = codes.map(b => b.padStart(2, "0"));
      } else if (keys !== undefined) {
        try {
          codes = resolveScancodes(keys);
        } catch (e) {
          return {
            content: [{ type: "text", text: `Error: ${formatError(e)}\n\nAvailable keys: ${getAvailableKeys().join(", ")}` }],
            isError: true,
          };
        }
      } else {
        return {
          content: [{ type: "text", text: "Error: provide either 'keys' (named combo) or 'raw' (hex scancode bytes)." }],
          isError: true,
        };
      }

      for (let i = 0; i < count; i++) {
        await vboxManage("controlvm", vm, "keyboardputscancode", ...codes);
        if (i < count - 1 && delayMs > 0) {
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
      const label = raw !== undefined ? `raw [${codes.join(" ")}]` : `"${keys}"`;
      return { content: [{ type: "text", text: `Sent ${label} x${count} (scancodes: ${codes.join(" ")})` }] };
    },
  );

  server.tool(
    "vm_keyboard_type",
    "Type printable text string into the VM (uses keyboardputstring). For special keys use vm_keyboard_scancode instead. Long strings are chunked with an inter-chunk delay to avoid overrunning the guest keyboard buffer (which silently drops characters).",
    {
      vm: z.string().describe("VM name or UUID"),
      text: z.string().describe("Text to type"),
      chunkSize: z.number().default(50).describe("Max characters sent per keyboardputstring call. Smaller is safer; the guest keyboard buffer overruns and drops characters if fed too much at once."),
      delayMs: z.number().default(30).describe("Delay in ms between chunks, giving the guest time to drain its keyboard buffer."),
    },
    async ({ vm, text, chunkSize, delayMs }) => {
      const size = Math.max(1, chunkSize);
      for (let i = 0; i < text.length; i += size) {
        const chunk = text.slice(i, i + size);
        await vboxManage("controlvm", vm, "keyboardputstring", chunk);
        if (i + size < text.length && delayMs > 0) {
          await new Promise(r => setTimeout(r, delayMs));
        }
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
