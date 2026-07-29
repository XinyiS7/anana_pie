import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_OUTPUT = 50_000;
const GIT_TIMEOUT_MS = 30_000;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "review_git",
    label: "Review Git",
    description:
      "Run read-only git operations for code review: status, diff, show, log, changed_files. Cannot mutate the repository.",
    promptSnippet: "Run read-only git status, diff, show, log, changed_files",
    promptGuidelines: [
      "Use review_git to inspect git status, diffs, show specific commits, or view commit log. It is strictly read-only.",
    ],
    parameters: Type.Object({
      action: StringEnum(
        ["status", "diff", "show", "log", "changed_files"] as const,
      ),
      ref: Type.Optional(
        Type.String({
          description:
            "Git ref (commit, branch, tag). Required for show. Optional base for diff/changed_files.",
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: "Restrict output to a specific path.",
        }),
      ),
      staged: Type.Optional(
        Type.Boolean({
          description: "For diff: show staged (--cached) changes instead of unstaged.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "For log: number of commits (default 20, max 200).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const built = buildArgv(params);
      if (!built.ok) {
        return {
          content: [{ type: "text", text: `review_git error: ${built.error}` }],
          details: { action: params.action, error: built.error },
          isError: true,
        };
      }

      let result;
      try {
        result = await pi.exec("git", built.value, {
          signal,
          timeout: GIT_TIMEOUT_MS,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `review_git failed: ${message}` }],
          details: { action: params.action, error: message },
          isError: true,
        };
      }

      const output = combineOutput(result.stdout, result.stderr);
      const text =
        output.length > MAX_OUTPUT
          ? `${output.slice(0, MAX_OUTPUT)}\n\n... (truncated, ${output.length - MAX_OUTPUT} more chars)`
          : output || "(no output)";

      if (result.code !== 0) {
        return {
          content: [
            { type: "text", text: `git exited ${result.code}:\n${text}` },
          ],
          details: { action: params.action, exitCode: result.code },
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text }],
        details: { action: params.action, exitCode: result.code },
      };
    },
  });
}

type ReviewGitParams = {
  action: string;
  ref?: string;
  path?: string;
  staged?: boolean;
  limit?: number;
};

function buildArgv(
  params: ReviewGitParams,
): { ok: true; value: string[] } | { ok: false; error: string } {
  const ref = params.ref?.trim();
  const target = params.path?.trim();

  if (ref !== undefined && ref !== "" && ref.startsWith("-")) {
    return { ok: false, error: "ref must not start with '-'" };
  }

  switch (params.action) {
    case "status":
      return { ok: true, value: ["status", "--porcelain"] };

    case "diff": {
      const argv = ["diff"];
      if (params.staged) argv.push("--cached");
      if (ref) argv.push(ref);
      if (target) argv.push("--", target);
      return { ok: true, value: argv };
    }

    case "show": {
      if (!ref) return { ok: false, error: "show requires a ref" };
      const argv = ["show", ref];
      if (target) argv.push("--", target);
      return { ok: true, value: argv };
    }

    case "log": {
      const limit = clampInt(params.limit, 1, 200, 20);
      return { ok: true, value: ["log", `-n${limit}`, "--oneline"] };
    }

    case "changed_files": {
      const argv = ["diff", "--name-only"];
      if (ref) argv.push(ref);
      if (target) argv.push("--", target);
      return { ok: true, value: argv };
    }

    default:
      return { ok: false, error: `unknown action: ${params.action}` };
  }
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function combineOutput(stdout: unknown, stderr: unknown): string {
  const out = typeof stdout === "string" ? stdout : "";
  const err =
    typeof stderr === "string" && stderr.trim()
      ? `\n[stderr]\n${stderr}`
      : "";
  return `${out}${err}`.trim();
}
