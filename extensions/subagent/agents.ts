/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	aliases: string[];
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function normalizeName(value: string): string {
	return value.trim().toLowerCase();
}

function parseStringList(value: unknown): string[] {
	const values = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
	return values
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
}

function uniqueNormalized(values: string[], excluded = ""): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	const excludedName = normalizeName(excluded);
	for (const value of values) {
		const normalized = normalizeName(value);
		if (!normalized || normalized === excludedName || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

function mergeAliases(primary: AgentConfig, inherited?: AgentConfig): AgentConfig {
	if (!inherited) return primary;
	return {
		...primary,
		aliases: uniqueNormalized([...primary.aliases, ...inherited.aliases], primary.name),
	};
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
		const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
		if (!name || !description) continue;

		const tools = parseStringList(frontmatter.tools);
		const aliases = uniqueNormalized(parseStringList(frontmatter.aliases), name);
		const model = typeof frontmatter.model === "string" ? frontmatter.model.trim() : "";

		agents.push({
			name,
			description,
			aliases,
			tools: tools.length > 0 ? tools : undefined,
			model: model || undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(normalizeName(agent.name), agent);
		for (const agent of projectAgents) {
			const key = normalizeName(agent.name);
			agentMap.set(key, mergeAliases(agent, agentMap.get(key)));
		}
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(normalizeName(agent.name), agent);
	} else {
		for (const agent of projectAgents) agentMap.set(normalizeName(agent.name), agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function findAgentByName(agents: AgentConfig[], requestedName: string): AgentConfig | undefined {
	const requested = normalizeName(requestedName);
	if (!requested) return undefined;
	const canonical = agents.find((agent) => normalizeName(agent.name) === requested);
	if (canonical) return canonical;
	const aliasMatches = agents.filter((agent) => agent.aliases.includes(requested));
	return aliasMatches.length === 1 ? aliasMatches[0] : undefined;
}

export function formatAgentName(agent: AgentConfig): string {
	return agent.aliases.length > 0 ? `${agent.name} [aliases: ${agent.aliases.join(", ")}]` : agent.name;
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((agent) => `${formatAgentName(agent)} (${agent.source}): ${agent.description}`).join("; "),
		remaining,
	};
}