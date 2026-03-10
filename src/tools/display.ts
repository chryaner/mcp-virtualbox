import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { vboxManage, parseMachineReadable } from "../vbox.js";
import { config } from "../types.js";

export function registerDisplayTools(server: McpServer) {
  server.tool(
    "vm_screenshot",
    "Take a screenshot of the VM display, returns as image. Use this in a vision loop during OS installation: screenshot → analyze → send input → repeat.",
    { vm: z.string().describe("VM name or UUID") },
    async ({ vm }) => {
      const filename = `screenshot_${Date.now()}.png`;
      const filepath = join(config.screenshotDir, filename);
      await vboxManage("controlvm", vm, "screenshotpng", filepath);
      const buffer = await readFile(filepath);
      await unlink(filepath).catch(() => {});
      const base64 = buffer.toString("base64");
      return {
        content: [{
          type: "image",
          data: base64,
          mimeType: "image/png",
        }],
      };
    },
  );

  server.tool(
    "vm_screen_info",
    "Get VM display resolution and settings",
    { vm: z.string().describe("VM name or UUID") },
    async ({ vm }) => {
      const output = await vboxManage("showvminfo", vm, "--machinereadable");
      const info = parseMachineReadable(output);

      // VideoMode format: "720,400,0"@0,0 1  (width,height,bpp @ x,y screen)
      const videoMode = info["VideoMode"] || "";
      const resMatch = videoMode.match(/(\d+),(\d+),(\d+)/);
      const screenInfo = {
        width: resMatch?.[1] || "unknown",
        height: resMatch?.[2] || "unknown",
        bpp: resMatch?.[3] || "unknown",
        vram: info["vram"] || info["VRAMSize"],
        graphicsController: info["graphicscontroller"] || info["GraphicsControllerType"],
        monitors: info["monitorcount"],
      };
      return { content: [{ type: "text", text: JSON.stringify(screenInfo, null, 2) }] };
    },
  );
}
