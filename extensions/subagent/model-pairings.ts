import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const THINKING_LEVELS = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export interface SubagentModelPairing {
	model: string;
	thinking?: string;
}

interface PairingConfig {
	version: 1;
	parentModels: Record<string, SubagentModelPairing>;
}

export class SubagentModelPairingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubagentModelPairingError";
	}
}

export function getSubagentModelPairingPath(): string {
	return path.join(getAgentDir(), "subagent-model-pairings.json");
}

export function loadSubagentModelPairing(parentModel: string | null): SubagentModelPairing | null {
	if (!parentModel) return null;

	const filePath = getSubagentModelPairingPath();
	if (!fs.existsSync(filePath)) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		throw new SubagentModelPairingError(
			`Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const config = parseConfig(parsed, filePath);
	return config.parentModels[parentModel] ?? null;
}

function parseConfig(value: unknown, filePath: string): PairingConfig {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.parentModels)) {
		throw new SubagentModelPairingError(
			`${filePath} must contain version 1 and a parentModels object`,
		);
	}

	const parentModels: Record<string, SubagentModelPairing> = {};
	for (const [parentModel, rawPairing] of Object.entries(value.parentModels)) {
		if (!isModelReference(parentModel)) {
			throw new SubagentModelPairingError(
				`${filePath} has invalid parent model reference "${parentModel}"`,
			);
		}
		if (!isRecord(rawPairing) || !isModelReference(rawPairing.model)) {
			throw new SubagentModelPairingError(
				`${filePath} has invalid child model pairing for "${parentModel}"`,
			);
		}

		const thinking = rawPairing.thinking;
		if (thinking !== undefined && (typeof thinking !== "string" || !THINKING_LEVELS.has(thinking))) {
			throw new SubagentModelPairingError(
				`${filePath} has invalid thinking level for "${parentModel}"`,
			);
		}

		parentModels[parentModel] = {
			model: rawPairing.model,
			...(typeof thinking === "string" ? { thinking } : {}),
		};
	}

	return { version: 1, parentModels };
}

function isModelReference(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const separator = value.indexOf("/");
	return separator > 0 && separator < value.length - 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
