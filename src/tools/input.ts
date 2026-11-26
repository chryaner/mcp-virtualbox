import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { vboxManage, formatError } from "../vbox.js";
import { resolveScancodes, getAvailableKeys } from "../scancodes.js";
import { config } from "../types.js";
import { MOUSE_BUTTONS, putMouseEvents, putMouseWheel, type MouseButton, type MouseEvent } from "../webservice.js";

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
    "Click at absolute screen coordinates. Coordinates are screenshot pixels: (0, 0) is the top-left corner of what vm_screenshot returns. The VM needs a USB tablet as its pointing device, which vm_create sets up.",
    {
      vm: z.string().describe("VM name or UUID"),
      x: z.number().describe("X coordinate (pixels from left)"),
      y: z.number().describe("Y coordinate (pixels from top)"),
      button: z.enum(["left", "right", "middle"]).default("left").describe("Mouse button"),
      doubleClick: z.boolean().default(false).describe("Double click"),
    },
    async ({ vm, x, y, button, doubleClick }) => {
      const done = `Clicked ${button} at (${x}, ${y})${doubleClick ? " (double)" : ""}`;
      try {
        await putMouseEvents(vm, clickEvents(x, y, button, doubleClick));
        return { content: [{ type: "text", text: done }] };
      } catch (e) {
        // The web service ships with VirtualBox, so this is the rare
        // installation without it, or one where it will not start. The Python
        // helper this tool used before 1.1 is still tried, for a click only.
        const viaPython = await clickWithPython(vm, x, y, button, doubleClick);
        if (viaPython === undefined) return { content: [{ type: "text", text: done }] };
        return {
          content: [{ type: "text", text: `Mouse click failed: ${formatError(e)}\nThe Python fallback failed too: ${viaPython}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "vm_mouse_move",
    "Move the mouse pointer to absolute screen coordinates without pressing a button: to hover over something, or to aim vm_mouse_scroll. Coordinates are screenshot pixels.",
    {
      vm: z.string().describe("VM name or UUID"),
      x: z.number().describe("X coordinate (pixels from left)"),
      y: z.number().describe("Y coordinate (pixels from top)"),
    },
    async ({ vm, x, y }) => {
      try {
        await putMouseEvents(vm, [{ x, y, buttons: 0 }]);
        return { content: [{ type: "text", text: `Moved to (${x}, ${y})` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Mouse move failed: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "vm_mouse_scroll",
    "Turn the mouse wheel. It scrolls whatever is under the pointer, so pass x and y to aim it first, or omit them to scroll where the pointer already is.",
    {
      vm: z.string().describe("VM name or UUID"),
      clicks: z.number().int().describe("Wheel notches: positive scrolls down, negative scrolls up"),
      x: z.number().optional().describe("X coordinate to move the pointer to first (pixels from left). Give both x and y, or neither."),
      y: z.number().optional().describe("Y coordinate to move the pointer to first (pixels from top). Give both x and y, or neither."),
    },
    async ({ vm, clicks, x, y }) => {
      if ((x === undefined) !== (y === undefined)) {
        return { content: [{ type: "text", text: "Error: give both x and y to aim the scroll, or neither." }], isError: true };
      }
      try {
        if (x !== undefined && y !== undefined) await putMouseEvents(vm, [{ x, y, buttons: 0 }]);
        await putMouseWheel(vm, clicks);
        const where = x !== undefined ? ` at (${x}, ${y})` : "";
        return { content: [{ type: "text", text: `Scrolled ${clicks > 0 ? "down" : "up"} ${Math.abs(clicks)}${where}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Mouse scroll failed: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "vm_mouse_drag",
    "Press a mouse button at one point, move to another and release: drag a window, a slider or a file, or select a region. Coordinates are screenshot pixels.",
    {
      vm: z.string().describe("VM name or UUID"),
      fromX: z.number().describe("X coordinate to press at (pixels from left)"),
      fromY: z.number().describe("Y coordinate to press at (pixels from top)"),
      toX: z.number().describe("X coordinate to release at (pixels from left)"),
      toY: z.number().describe("Y coordinate to release at (pixels from top)"),
      button: z.enum(["left", "right", "middle"]).default("left").describe("Mouse button to hold"),
      steps: z.number().int().min(1).max(100).default(10).describe("Intermediate positions the pointer passes through. Programs that track a drag ignore a pointer that jumps straight to the end."),
    },
    async ({ vm, fromX, fromY, toX, toY, button, steps }) => {
      try {
        await putMouseEvents(vm, dragEvents(fromX, fromY, toX, toY, button, steps), 20);
        return { content: [{ type: "text", text: `Dragged ${button} from (${fromX}, ${fromY}) to (${toX}, ${toY})` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Mouse drag failed: ${formatError(e)}` }], isError: true };
      }
    },
  );
}

// A click is the pointer arriving, the button going down and coming up
// again; a double click is that twice.
export function clickEvents(x: number, y: number, button: MouseButton, double: boolean): MouseEvent[] {
  const down = MOUSE_BUTTONS[button];
  const once: MouseEvent[] = [{ x, y, buttons: down }, { x, y, buttons: 0 }];
  return [{ x, y, buttons: 0 }, ...once, ...(double ? once : [])];
}

// A drag is the pointer arriving, the button going down, the pointer
// travelling in a straight line with the button held, and the button coming
// up at the far end.
export function dragEvents(fromX: number, fromY: number, toX: number, toY: number, button: MouseButton, steps: number): MouseEvent[] {
  const down = MOUSE_BUTTONS[button];
  const events: MouseEvent[] = [{ x: fromX, y: fromY, buttons: 0 }, { x: fromX, y: fromY, buttons: down }];
  for (let i = 1; i <= steps; i++) {
    events.push({
      x: Math.round(fromX + ((toX - fromX) * i) / steps),
      y: Math.round(fromY + ((toY - fromY) * i) / steps),
      buttons: down,
    });
  }
  events.push({ x: toX, y: toY, buttons: 0 });
  return events;
}

// Resolves to undefined when the click went through, or to why it did not.
function clickWithPython(vm: string, x: number, y: number, button: string, double: boolean): Promise<string | undefined> {
  return new Promise((resolve) => {
    const args = [config.mouseHelperPath, vm, String(x), String(y), button];
    if (double) args.push("--double");
    execFile(config.pythonPath, args, { timeout: config.defaultTimeout }, (err, _stdout, stderr) => {
      resolve(err ? (stderr.trim() || err.message) : undefined);
    });
  });
}
