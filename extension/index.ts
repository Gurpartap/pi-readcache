import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createReadOverrideTool } from "./src/tool.js";

export default function (pi: ExtensionAPI): void {
	pi.registerTool(createReadOverrideTool());
}
