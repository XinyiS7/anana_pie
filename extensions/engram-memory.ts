/**
 * Engram Memory Extension — cross-session memory for pi
 *
 * Wraps engram (HTTP API on :7437) as pi custom tools:
 *   - mem_save   — persist a memory (decision, bugfix, pattern, etc.)
 *   - mem_edit   — partially update an existing memory by ID
 *   - mem_recall — search memories by keyword
 *   - mem_stats  — show memory store statistics
 *
 * No automatic history injection: the model only sees engram content when it
 * explicitly calls mem_context / mem_recall. The status line on session_start
 * is purely cosmetic (server reachability + store size).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ENGRAM_PORT = 7437;
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
  // engram's /search returns literal `null` (not []) when a type-filtered
  // query has no matches — normalize to [] so callers can safely read .length.
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as EngramMemory[]) : [];
}

async function engramUpdate(id: number, fields: {
  title?: string;
  type?: string;
  content?: string;
  project?: string;
  scope?: string;
  topicKey?: string;
}): Promise<EngramMemory> {
  // PATCH /observations/{id} — partial update, only provided fields change.
  // JSON field names are snake_case (verified against engram store.go).
  const body: Record<string, string> = {};
  if (fields.title !== undefined) body.title = fields.title;
  if (fields.type !== undefined) body.type = fields.type;
  if (fields.content !== undefined) body.content = fields.content;
  if (fields.project !== undefined) body.project = fields.project;
  if (fields.scope !== undefined) body.scope = fields.scope;
  if (fields.topicKey !== undefined) body.topic_key = fields.topicKey;

  const res = await fetch(`${ENGRAM_BASE}/observations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`engram update failed: ${res.status} ${res.statusText} ${detail}`);
  }
  return res.json() as Promise<EngramMemory>;
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

async function engramSave(title: string, content: string, opts?: {
  type?: string;
  project?: string;
  scope?: string;
  topicKey?: string;
}): Promise<{ id: number; status: string }> {
  // HTTP POST /observations — CLI execSync path drops --type/--project when
  // content contains newlines (cmd.exe quote parsing), and can't set topic_key.
  // session_id must be non-empty; "manual-save" matches the CLI's default.
  const body: Record<string, string> = {
    session_id: "manual-save",
    title,
    content,
  };
  if (opts?.type) body.type = opts.type;
  if (opts?.project) body.project = opts.project;
  if (opts?.scope) body.scope = opts.scope;
  if (opts?.topicKey) body.topic_key = opts.topicKey;

  const res = await fetch(`${ENGRAM_BASE}/observations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`engram save failed: ${res.status} ${res.statusText} ${detail}`);
  }
  return res.json() as Promise<{ id: number; status: string }>;
}

function formatMemoryCard(m: EngramMemory, idx: number): string {
  const date = m.created_at?.slice(0, 19) || "unknown";
  const topic = m.topic_key ? ` [${m.topic_key}]` : "";
  const project = m.project || "?";
  return `**[${idx}] ${m.title}** (${m.type})${topic}\n${m.content.slice(0, 300)}${m.content.length > 300 ? "..." : ""}\n_${date} | project: ${project}_`;
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
      const saved = await engramSave(params.title, params.content, {
        type: params.type,
        project: params.project,
        scope: params.scope,
        topicKey: params.topic_key,
      });
      return {
        content: [
          { type: "text", text: `Memory saved to engram (#${saved.id}):\n${saved.status}` },
        ],
        details: { id: saved.id, title: params.title, type: params.type },
      };
    },
  });

  pi.registerTool({
    name: "mem_edit",
    label: "Edit Memory",
    description:
      "Update an existing engram memory by ID — partial update, only provided fields change. " +
      "Use to fix a title, append corrections to content, or change type/scope/topic_key of an existing memory. " +
      "Find the ID via mem_recall or mem_context. Returns the updated memory.",
    parameters: Type.Object({
      id: Type.Number({ description: "Memory ID to update (from mem_recall / mem_context results)" }),
      title: Type.Optional(Type.String({ description: "New title" })),
      type: Type.Optional(Type.String({
        description: "New type: decision, bugfix, pattern, architecture, session_summary, convention, exploration",
      })),
      content: Type.Optional(Type.String({ description: "New full content" })),
      topic_key: Type.Optional(Type.String({ description: "New topic key (normalized internally)" })),
      project: Type.Optional(Type.String({ description: "New project name" })),
      scope: Type.Optional(Type.String({ description: "New scope: project or user" })),
    }),
    async execute(_toolCallId, params) {
      const updated = await engramUpdate(params.id, {
        title: params.title,
        type: params.type,
        content: params.content,
        project: params.project,
        scope: params.scope,
        topicKey: params.topic_key,
      });
      return {
        content: [
          {
            type: "text",
            text: `Memory #${updated.id} updated:\n${formatMemoryCard(updated, 1)}`,
          },
        ],
        details: { id: updated.id, title: updated.title, type: updated.type },
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
      type: Type.Optional(Type.String({
        description: "Filter by memory type: decision, bugfix, pattern, architecture, session_summary",
      })),
      limit: Type.Optional(Type.Number({
        description: "Max results (default: 5, max: 10)",
        default: 5,
      })),
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

  /* ---- startup: surface engram status (no history injection) ---- */

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

}
