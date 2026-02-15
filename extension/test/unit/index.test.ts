import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import registerExtension from "../../index.js";

describe("index extension wiring", () => {
	it("registers read override, readcache controls, and cache-invalidation event hooks", () => {
		const registeredTools: string[] = [];
		const registeredCommands: string[] = [];
		const eventHandlers = new Map<string, (...args: unknown[]) => void>();

		const api = {
			registerTool: (definition: { name: string }) => {
				registeredTools.push(definition.name);
			},
			registerCommand: (name: string) => {
				registeredCommands.push(name);
			},
			on: (eventName: string, handler: (...args: unknown[]) => void) => {
				eventHandlers.set(eventName, handler);
			},
		} as unknown as ExtensionAPI;

		registerExtension(api);

		expect(registeredTools).toContain("read");
		expect(registeredTools).toContain("readcache_refresh");
		expect(registeredCommands).toContain("readcache-status");
		expect(registeredCommands).toContain("readcache-refresh");

		expect(eventHandlers.has("session_compact")).toBe(true);
		expect(eventHandlers.has("session_tree")).toBe(true);
		expect(eventHandlers.has("session_fork")).toBe(true);
		expect(eventHandlers.has("session_switch")).toBe(true);
		expect(eventHandlers.has("session_shutdown")).toBe(true);
	});
});
