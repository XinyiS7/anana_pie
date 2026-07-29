/**
 * Engram Memory Extension — cross-session memory for pi
 *
 * Wraps engram (HTTP API on :7437 + CLI) as pi custom tools:
 *   - mem_save   — persist a memory (decision, bugfix, pattern, etc.)
 *   - mem_recall — search memories by keyword
 *   - mem_stats  — show memory store statistics
 *
 * On session_start, injects a summary of recent memories into the system prompt.
 */

import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ENGRAM_PORT = 7437;
const ENGRAM_EXE = "engram.exe";
const ENGRAM_BASE = `http://127.0.0.1:${ENGRAM_PORT}`;

/* --------------- helpers --------------- */

interface EngramMemory {
  id: number;
  sync_id: string;
  type: string;
  title: string;
  content: string;
  project: string;
  scope: string;
  topic_key?: string;
  created_at: string;
  updated_at: string;
  rank?: number;
}

interface EngramStats {
  total_sessions: number;
  total_observations: number;
  total_prompts: number;
  projects: string[];
}

async function engramSearch(query: string, opts?: {
  type?: string;
  project?: string;
  limit?: number;
}): Promise<EngramMemory[]> {
  const params = new URLSearchParams();
  params.set("q", query);
  if (opts?.type) params.set("type", opts.type);
  if (opts?.project) params.set("project", opts.project);
  if (opts?.limit) params.set("limit", String(opts.limit));

  const url = `${ENGRAM_BASE}/search?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`engram search failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<EngramMemory[]>;
}

async function engramStats(): Promise<EngramStats> {
  const res = await fetch(`${ENGRAM_BASE}/stats`);
  if (!res.ok) {
    throw new Error(`engram stats failed: ${res.status}`);
  }
  return res.json() as Promise<EngramStats>;
}

interface EngramContext {
  context: string;
}

async function engramContext(project?: string): Promise<string> {
  const params = project ? `?project=${encodeURIComponent(project)}` : "";
  const res = await fetch(`${ENGRAM_BASE}/context${params}`);
  if (!res.ok) {
    throw new Error(`engram context failed: ${res.status}`);
  }
  const data = (await res.json()) as EngramContext;
  return data.context;
}

function engramSave(title: string, content: string, opts?: {
  type?: string;
  project?: string;
  scope?: string;
  topicKey?: string;
}): string {
  const args = ["save", title, content];
  if (opts?.type) args.push("--type", opts.type);
  if (opts?.project) args.push("--project", opts.project);
  if (opts?.scope) args.push("--scope", opts.scope);
  // topic_key not supported by CLI directly; prepend to content if given
  let finalContent = content;
  if (opts?.topicKey) {
    finalContent = `**Topic**: ${opts.topicKey}\n\n${content}`;
  }

  // Build command with final args (replacing content with topic-enriched version)
  const finalArgs = ["save", title, finalContent];
  if (opts?.type) finalArgs.push("--type", opts.type);
  if (opts?.project) finalArgs.push("--project", opts.project);
  if (opts?.scope) finalArgs.push("--scope", opts.scope);

  try {
    const output = execSync(`${ENGRAM_EXE} ${finalArgs.map(a => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`, {
      encoding: "utf-8",
      timeout: 15000,
      env: { ...process.env },
    });
    return output.trim();
  } catch (err: any) {
    const stderr = err.stderr || err.message || "";
    throw new Error(`engram save failed: ${stderr}`);
  }
}

function formatMemoryCard(m: EngramMemory, idx: number): string {
  const date = m.created_at?.slice(0, 19) || "unknown";
  const topic = m.topic_key ? ` [${m.topic_key}]` : "";
  return `**[${idx}] ${m.title}** (${m.type})${topic}\n${m.content.slice(0, 300)}${m.content.length > 300 ? "..." : ""}\n_${date} | project: ${m.project}_`;
}

/* --------------- extension --------------- */

export default function (pi: ExtensionAPI) {
  /* ---- tools ---- */

  pi.registerTool({
    name: "mem_save",
    label: "Save Memory",
    description:
      "Save a cross-session memory to engram. Use for architecture decisions, bug root causes, new patterns, or key discoveries that should persist across CLI sessions. Format content with **What** / **Why** / **Where** / **Learned** sections.",
    parameters: Type.Object({
      title: Type.String({ description: "Short title summarizing the memory" }),
      type: Type.String({
        description: "Memory type: decision, bugfix, pattern, architecture, session_summary, convention, exploration",
        default: "decision",
      }),
      topic_key: Type.String({
        description: "Topic key for grouping related memories (e.g., architecture/context-cache)",
      }),
      content: Type.String({
        description:
          "Full memory content. Structure with **What** / **Why** / **Where** / **Learned** sections. Be specific with file paths, commit hashes, and rationale.",
      }),
      project: Type.String({
        description: "Project name (default: exocore)",
        default: "exocore",
      }),
      scope: Type.String({
        description: "Scope: project or user",
        default: "project",
      }),
    }),
    async execute(_toolCallId, params) {
      const output = engramSave(params.title, params.content, {
        type: params.type,
        project: params.project,
        scope: params.scope,
        topicKey: params.topic_key,
      });
      return {
        content: [{ type: "text", text: `Memory saved to engram:\n${output}` }],
        details: { title: params.title, type: params.type },
      };
    },
  });

  pi.registerTool({
    name: "mem_recall",
    label: "Recall Memories",
    description:
      "Search cross-session memories in engram by keyword. Use to recall past architecture decisions, bug fixes, patterns, or conventions before making changes.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query (keywords)" }),
      type: Type.String({
        description: "Filter by memory type: decision, bugfix, pattern, architecture, session_summary",
      }),
      limit: Type.Number({
        description: "Max results (default: 5, max: 10)",
        default: 5,
      }),
    }),
    async execute(_toolCallId, params) {
      const limit = Math.min(params.limit || 5, 10);
      const memories = await engramSearch(params.query, {
        type: params.type,
        project: "exocore",
        limit,
      });

      if (memories.length === 0) {
        return {
          content: [{ type: "text", text: `No engram memories found for "${params.query}".` }],
          details: { count: 0 },
        };
      }

      const cards = memories.map((m, i) => formatMemoryCard(m, i + 1)).join("\n\n---\n\n");
      return {
        content: [
          {
            type: "text",
            text: `## Engram Memories: "${params.query}" (${memories.length} results)\n\n${cards}`,
          },
        ],
        details: { count: memories.length, ids: memories.map((m) => m.id) },
      };
    },
  });

  pi.registerTool({
    name: "mem_stats",
    label: "Memory Stats",
    description: "Show engram memory store statistics (total memories, sessions, projects).",
    parameters: Type.Object({}),
    async execute() {
      const stats = await engramStats();
      return {
        content: [
          {
            type: "text",
            text:
              `## Engram Memory Store\n` +
              `- Total memories: ${stats.total_observations}\n` +
              `- Total sessions: ${stats.total_sessions}\n` +
              `- Total prompts: ${stats.total_prompts}\n` +
              `- Projects: ${stats.projects.join(", ")}`,
          },
        ],
        details: stats,
      };
    },
  });

  pi.registerTool({
    name: "mem_context",
    label: "Recent Context",
    description:
      "Fetch recent session context from engram: recent sessions, user prompts, and key observations. Use at the start of a session or when reorienting after a long task to understand what was recently discussed and decided.",
    parameters: Type.Object({
      project: Type.String({
        description: "Project name (default: exocore)",
        default: "exocore",
      }),
    }),
    async execute(_toolCallId, params) {
      const context = await engramContext(params.project);
      return {
        content: [
          {
            type: "text",
            text: `## Recent Engram Context\n\n${context}`,
          },
        ],
        details: { project: params.project },
      };
    },
  });

  /* ---- startup: inject recent memory context ---- */

  pi.on("session_start", async (_event, ctx) => {
    try {
      const stats = await engramStats();
      ctx.ui.setStatus(
        "engram",
        `${stats.total_observations} memories across ${stats.projects.length} projects`
      );
    } catch {
      // engram not available — silently skip
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Fetch recent engram context and inject into system prompt.
    // This gives the LLM awareness of recent sessions, decisions, and patterns
    // without needing to call mem_context explicitly.
    let contextBlock = "";
    try {
      const ctxText = await engramContext("exocore");
      // Truncate to ~3000 chars to avoid blowing up the system prompt.
      // The LLM can call mem_context / mem_recall for more detail.
      const truncated = ctxText.length > 3500
        ? ctxText.slice(0, 3500) + "\n\n[... truncated, use mem_context for full context]"
        : ctxText;
      contextBlock = `\n\n## Cross-Session Memory (Engram)\n${truncated}\n\n`;
    } catch {
      // engram not available — inject minimal hint instead
      contextBlock =
        "\n\n## Cross-Session Memory (Engram)\n" +
        "Engram memory service is not reachable. Tools may still work if it comes back.\n";
    }

    const hint =
      "Engram tools available:\n" +
      "- `mem_context` — fetch recent session context (sessions, prompts, observations)\n" +
      "- `mem_recall` — search past architecture decisions, bug fixes, patterns (use BEFORE making changes)\n" +
      "- `mem_save` — persist discoveries, decisions, bug root causes (use AFTER key findings)\n" +
      "- `mem_stats` — show memory store statistics\n" +
      "Follow the AGENTS.md engram rules: save architecture decisions, bug root causes, new patterns, or key discoveries.\n" +
      "Format mem_save content with **What** / **Why** / **Where** / **Learned** sections.";

    return {
      systemPrompt: event.systemPrompt + contextBlock + hint,
    };
  });
}
