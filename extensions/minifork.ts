import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type {
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  Key,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import {
  clearMiniforkBehavior,
  clearReviewerPreference,
  loadMiniforkBehavior,
  loadReviewerPreference,
  ReviewerPreferenceError,
  saveMiniforkBehavior,
  saveReviewerPreference,
  type ReviewerRef,
} from "./minifork-support/reviewer-preference.js";
import {
  AgentPresetError,
  loadAgentPresetCatalog,
  resolveAgentBehavior,
  type BehaviorDefinition,
} from "./agent-presets-support/presets.js";

const DEFAULT_REVIEWER = {
  provider: "openai-codex",
  modelId: "gpt-5.6-sol",
};
const DEFAULT_MINIFORK_BEHAVIOR = "reviewer";
const REVIEWER_TOOLS = ["read", "grep", "find", "ls", "review_git"];
const MINIFORK_SAFETY_PROMPT = `This is a clean-room mini-fork consultation.

Use only the review packet and the repository state you inspect yourself. You have no access to the main conversation that produced the work, and you must not infer or defer to its reasoning.

You may inspect files with the available read-only tools. Do not edit files, write files, run arbitrary shell commands, or make repository changes.`;
const CHILD_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_STDERR_CHARS = 20_000;
const MAX_PROGRESS_ITEMS = 8;

interface ReviewPacket {
  userRequest: string;
  assistantConclusion: string;
  modifiedFiles: string[];
}

interface ReviewerResult {
  text: string;
  sessionFile?: string;
}

interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

interface ActiveReview {
  child: ChildProcessWithoutNullStreams;
  reviewer: { provider: string; modelId: string };
  behavior: string;
  reviewRequest: string;
  progress: ProgressReporter;
  userAborted: boolean;
}

type ReviewerSelection =
  | { kind: "model"; reviewer: ReviewerRef }
  | { kind: "reset" }
  | { kind: "cancel" };

type BehaviorSelection =
  | { kind: "behavior"; name: string }
  | { kind: "reset" }
  | { kind: "cancel" };

export default function (pi: ExtensionAPI) {
  let disposed = false;
  let mainStreaming = false;
  let activeReview: ActiveReview | null = null;

  const terminateActiveReview = (reason: string): void => {
    const review = activeReview;
    if (!review) return;
    review.progress.add(`Terminating reviewer (${reason})`);
    terminateChild(review.child);
    activeReview = null;
  };

  pi.on("session_shutdown", () => {
    disposed = true;
    terminateActiveReview("session shutdown");
  });

  pi.on("agent_start", () => {
    mainStreaming = true;
  });

  pi.on("agent_settled", () => {
    mainStreaming = false;
  });

  pi.registerCommand("minifork-abort", {
    description: "Abort the active mini-fork reviewer",
    handler: async (_args, ctx) => {
      if (!activeReview) {
        ctx.ui.notify("No mini-fork reviewer is running", "info");
        return;
      }
      activeReview.userAborted = true;
      terminateActiveReview("user abort");
      ctx.ui.notify("Mini-fork reviewer aborted", "warning");
    },
  });

  pi.registerCommand("minifork-model", {
    description: "Choose the reviewer model for /minifork",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/minifork-model requires interactive mode", "warning");
        return;
      }

      let current: ReviewerRef;
      try {
        current = loadReviewerPreference() ?? DEFAULT_REVIEWER;
      } catch (err) {
        const message =
          err instanceof ReviewerPreferenceError
            ? err.message
            : String(err);
        ctx.ui.notify(message, "error");
        return;
      }

      const available = ctx.modelRegistry.getAvailable();
      const items: SelectItem[] = [];

      const defaultLabel = `${DEFAULT_REVIEWER.provider}/${DEFAULT_REVIEWER.modelId}`;
      items.push({
        value: "__reset__",
        label: "Reset to built-in default",
        description: defaultLabel,
      });

      const sorted = [...available].sort((a, b) => {
        const pa = a.provider.localeCompare(b.provider);
        if (pa !== 0) return pa;
        return a.id.localeCompare(b.id);
      });

      const currentKey = `${current.provider}/${current.modelId}`;

      for (const model of sorted) {
        const key = `${model.provider}/${model.id}`;
        const traits = model.reasoning ? " · reasoning" : "";
        const isCurrent = key === currentKey;
        items.push({
          value: key,
          label: key,
          description: isCurrent
            ? `${model.name}${traits} (current)`
            : `${model.name}${traits}`,
        });
      }

      const maxVisible = Math.min(items.length, 12);

      const selection = await ctx.ui.custom<ReviewerSelection>(
        (tui, theme, _keybindings, done) => {
          const container = new Container();

          container.addChild(
            new DynamicBorder((s: string) => theme.fg("accent", s)),
          );

          container.addChild(
            new Text(
              theme.fg("accent", theme.bold("Select Mini-fork Reviewer")),
              1,
              0,
            ),
          );

          const selectList = new SelectList(items, maxVisible, {
            selectedPrefix: (t: string) => theme.fg("accent", t),
            selectedText: (t: string) => theme.fg("accent", t),
            description: (t: string) => theme.fg("muted", t),
            scrollInfo: (t: string) => theme.fg("dim", t),
            noMatch: (t: string) => theme.fg("warning", t),
          });

          selectList.onSelect = (item) => {
            if (item.value === "__reset__") {
              done({ kind: "reset" });
              return;
            }
            const sep = item.value.indexOf("/");
            if (sep > 0) {
              done({
                kind: "model",
                reviewer: {
                  provider: item.value.slice(0, sep),
                  modelId: item.value.slice(sep + 1),
                },
              });
            } else {
              done({ kind: "cancel" });
            }
          };
          selectList.onCancel = () => done({ kind: "cancel" });

          container.addChild(selectList);

          container.addChild(
            new Text(
              theme.fg("dim", "type to filter · ↑↓ navigate · enter select · esc cancel"),
              1,
              0,
            ),
          );

          container.addChild(
            new DynamicBorder((s: string) => theme.fg("accent", s)),
          );

          let filter = "";

          return {
            render: (w) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data) => {
              if (
                data.length === 1 &&
                data.charCodeAt(0) >= 32 &&
                data.charCodeAt(0) <= 126
              ) {
                filter += data;
                selectList.setFilter(filter);
                tui.requestRender();
                return;
              }
              if (matchesKey(data, Key.backspace)) {
                filter = filter.slice(0, -1);
                selectList.setFilter(filter);
                tui.requestRender();
                return;
              }
              selectList.handleInput(data);
              tui.requestRender();
            },
          };
        },
      );

      if (selection.kind === "model") {
        try {
          await saveReviewerPreference(selection.reviewer);
          ctx.ui.notify(
            `Mini-fork reviewer set to ${selection.reviewer.provider}/${selection.reviewer.modelId}`,
            "info",
          );
        } catch (err) {
          const message =
            err instanceof ReviewerPreferenceError
              ? err.message
              : String(err);
          ctx.ui.notify(`Failed to save: ${message}`, "error");
        }
      } else if (selection.kind === "reset") {
        try {
          await clearReviewerPreference();
          ctx.ui.notify(
            `Mini-fork reviewer reset to built-in default (${DEFAULT_REVIEWER.provider}/${DEFAULT_REVIEWER.modelId})`,
            "info",
          );
        } catch (err) {
          const message =
            err instanceof ReviewerPreferenceError
              ? err.message
              : String(err);
          ctx.ui.notify(`Failed to reset: ${message}`, "error");
        }
      }
      // cancel → no-op
    },
  });

  pi.registerCommand("minifork-behavior", {
    description: "Choose the behavior for the mini-fork reviewer",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/minifork-behavior requires interactive mode", "warning");
        return;
      }

      let current = DEFAULT_MINIFORK_BEHAVIOR;
      try {
        current = loadMiniforkBehavior() ?? DEFAULT_MINIFORK_BEHAVIOR;
      } catch (err) {
        const message =
          err instanceof ReviewerPreferenceError
            ? err.message
            : String(err);
        ctx.ui.notify(message, "error");
        return;
      }

      const catalog = loadAgentPresetCatalog(
        ctx.cwd,
        ctx.isProjectTrusted(),
      );
      for (const error of catalog.errors) {
        ctx.ui.notify(`Agent preset config error: ${error}`, "error");
      }

      const items: SelectItem[] = [
        {
          value: "__reset__",
          label: "Reset to built-in behavior",
          description: DEFAULT_MINIFORK_BEHAVIOR,
        },
      ];
      const names = [...catalog.behaviors.keys()].sort();
      for (const name of names) {
        const behavior = catalog.behaviors.get(name);
        if (!behavior) continue;
        items.push({
          value: name,
          label: name,
          description:
            name === current
              ? `${behavior.displayName}${behavior.description ? ` · ${behavior.description}` : ""} (current)`
              : `${behavior.displayName}${behavior.description ? ` · ${behavior.description}` : ""}`,
        });
      }

      const selection = await showBehaviorSelector(ctx, items);
      if (!selection || selection.kind === "cancel") return;

      try {
        if (selection.kind === "reset") {
          await clearMiniforkBehavior();
          ctx.ui.notify(
            `Mini-fork behavior reset to built-in default (${DEFAULT_MINIFORK_BEHAVIOR})`,
            "info",
          );
          return;
        }

        resolveAgentBehavior(catalog, selection.name);
        await saveMiniforkBehavior(selection.name);
        ctx.ui.notify(
          `Mini-fork behavior set to ${selection.name}`,
          "info",
        );
      } catch (err) {
        const message =
          err instanceof ReviewerPreferenceError || err instanceof AgentPresetError
            ? err.message
            : String(err);
        ctx.ui.notify(`Failed to save behavior: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("minifork", {
    description: "Review the latest completed turn in an isolated pi session",
    handler: async (args, ctx) => {
      if (disposed) {
        ctx.ui.notify("Cannot start review: session is shutting down", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the main agent to finish first", "warning");
        return;
      }
      if (activeReview) {
        ctx.ui.notify("A mini-fork reviewer is already running", "warning");
        return;
      }

      const parsed = parseArgs(args);
      if (!parsed.reviewRequest) {
        ctx.ui.notify(
          "Usage: /minifork [--model provider/model] <review instructions>",
          "warning",
        );
        return;
      }

      let behavior: BehaviorDefinition;
      try {
        behavior = getConfiguredBehavior(ctx);
      } catch (err) {
        const message =
          err instanceof ReviewerPreferenceError || err instanceof AgentPresetError
            ? err.message
            : String(err);
        ctx.ui.notify(
          `${message} Run /minifork-behavior to choose a behavior.`,
          "error",
        );
        return;
      }

      let reviewer: ReviewerRef;

      if (parsed.modelOverride) {
        const parsedRef = parseModelRef(parsed.modelOverride);
        if (!parsedRef) {
          ctx.ui.notify(
            "Reviewer model must use provider/model format (e.g. openai-codex/gpt-5.6-sol)",
            "warning",
          );
          return;
        }
        reviewer = parsedRef;
      } else {
        let saved: ReviewerRef | null = null;
        try {
          saved = loadReviewerPreference();
        } catch (err) {
          const message =
            err instanceof ReviewerPreferenceError
              ? err.message
              : String(err);
          ctx.ui.notify(
            `${message} Run /minifork-model to choose a reviewer.`,
            "error",
          );
          return;
        }
        reviewer = saved ?? DEFAULT_REVIEWER;
      }

      const reviewerModel = ctx.modelRegistry.find(
        reviewer.provider,
        reviewer.modelId,
      );
      if (!reviewerModel) {
        ctx.ui.notify(
          `Reviewer model ${reviewer.provider}/${reviewer.modelId} not found`,
          "error",
        );
        return;
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(reviewerModel);
      if (!auth.ok || !auth.apiKey) {
        ctx.ui.notify(
          `No authentication for ${reviewer.provider}/${reviewer.modelId}`,
          "error",
        );
        return;
      }

      const packet = extractLatestCompletedTurn(ctx.sessionManager.getBranch());
      if (!packet) {
        ctx.ui.notify("No completed user→assistant turn found", "warning");
        return;
      }

      const prompt = buildReviewPrompt(parsed.reviewRequest, packet);
      const sessionName = buildSessionName(
        ctx.sessionManager.getSessionId(),
        behavior.name,
      );
      const thinkingLevel = reviewerModel.thinkingLevelMap?.max
        ? "max"
        : reviewerModel.reasoning
          ? "high"
          : "off";
      const progress = createProgressReporter(ctx, reviewer, sessionName);

      progress.add("Starting isolated reviewer process");

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnReviewer({
          cwd: ctx.cwd,
          reviewer,
          behavior,
          prompt,
          sessionName,
          thinkingLevel,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        progress.dispose();
        ctx.ui.notify(`Mini-fork failed to start: ${message}`, "error");
        return;
      }

      const review: ActiveReview = {
        child,
        reviewer,
        behavior: behavior.name,
        reviewRequest: parsed.reviewRequest,
        progress,
        userAborted: false,
      };
      activeReview = review;

      trackReviewer(child, { prompt, progress })
        .then((result) => {
          if (disposed) return;
          if (review.userAborted) return;

          const content = buildReviewMessage(
            reviewer,
            review.behavior,
            parsed.reviewRequest,
            result,
          );
          const options = mainStreaming
            ? { deliverAs: "nextTurn" as const, triggerTurn: false }
            : { triggerTurn: false };

          try {
            pi.sendMessage(
              {
                customType: "minifork_review",
                content,
                display: true,
                details: {
                  reviewer: `${reviewer.provider}/${reviewer.modelId}`,
                  behavior: review.behavior,
                  reviewSessionFile: result.sessionFile,
                },
              },
              options,
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            progress.add(`Failed to inject review: ${message}`);
          }

          const note = mainStreaming
            ? "Mini-fork review complete (queued for next turn)"
            : result.sessionFile
              ? `Mini-fork review complete. Session: ${result.sessionFile}`
              : "Mini-fork review complete";
          ctx.ui.notify(note, "info");
        })
        .catch((error) => {
          if (disposed) return;
          if (review.userAborted) return;
          const message =
            error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Mini-fork failed: ${message}`, "error");
        })
        .finally(() => {
          progress.dispose();
          if (!disposed) ctx.ui.setWidget("minifork", undefined);
          if (activeReview === review) activeReview = null;
        });

      ctx.ui.notify(
        `Mini-fork review started (${reviewer.provider}/${reviewer.modelId}, ${behavior.name}). Main session remains usable.`,
        "info",
      );
    },
  });
}

function parseArgs(args: string): {
  modelOverride: string | null;
  reviewRequest: string;
} {
  const match = args.match(/^--model\s+(\S+)\s*/);
  if (!match) {
    return { modelOverride: null, reviewRequest: args.trim() };
  }
  return {
    modelOverride: match[1],
    reviewRequest: args.slice(match[0].length).trim(),
  };
}

function parseModelRef(
  value: string,
): { provider: string; modelId: string } | null {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return null;
  return {
    provider: value.slice(0, separator),
    modelId: value.slice(separator + 1),
  };
}

function getConfiguredBehavior(
  ctx: ExtensionCommandContext,
): BehaviorDefinition {
  const catalog = loadAgentPresetCatalog(
    ctx.cwd,
    ctx.isProjectTrusted(),
  );
  for (const error of catalog.errors) {
    ctx.ui.notify(`Agent preset config error: ${error}`, "error");
  }

  const configured = loadMiniforkBehavior();
  return resolveAgentBehavior(
    catalog,
    configured ?? DEFAULT_MINIFORK_BEHAVIOR,
  );
}

async function showBehaviorSelector(
  ctx: ExtensionCommandContext,
  items: SelectItem[],
): Promise<BehaviorSelection | null> {
  if (items.length === 1) {
    ctx.ui.notify(
      `No agent behaviors found. Add a behavior file under ~/.pi/agent/agent-presets/behaviors/`,
      "warning",
    );
    return null;
  }

  const selection = await ctx.ui.custom<BehaviorSelection>(
    (tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(
        new DynamicBorder((s: string) => theme.fg("accent", s)),
      );
      container.addChild(
        new Text(theme.fg("accent", theme.bold("Select Mini-fork Behavior")), 1, 0),
      );

      const selectList = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (s: string) => theme.fg("accent", s),
        selectedText: (s: string) => theme.fg("accent", s),
        description: (s: string) => theme.fg("muted", s),
        scrollInfo: (s: string) => theme.fg("dim", s),
        noMatch: (s: string) => theme.fg("warning", s),
      });
      selectList.onSelect = (item) => {
        if (item.value === "__reset__") {
          done({ kind: "reset" });
          return;
        }
        done({ kind: "behavior", name: item.value });
      };
      selectList.onCancel = () => done({ kind: "cancel" });
      container.addChild(selectList);
      container.addChild(
        new Text(
          theme.fg("dim", "type to filter · ↑↓ navigate · enter select · esc cancel"),
          1,
          0,
        ),
      );
      container.addChild(
        new DynamicBorder((s: string) => theme.fg("accent", s)),
      );

      let filter = "";
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (
            data.length === 1 &&
            data.charCodeAt(0) >= 32 &&
            data.charCodeAt(0) <= 126
          ) {
            filter += data;
            selectList.setFilter(filter);
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.backspace)) {
            filter = filter.slice(0, -1);
            selectList.setFilter(filter);
            tui.requestRender();
            return;
          }
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );
  return selection ?? null;
}

function extractLatestCompletedTurn(
  entries: SessionEntry[],
): ReviewPacket | null {
  const messages = entries.filter(
    (entry): entry is SessionMessageEntry => entry.type === "message",
  );

  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].message.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return null;

  const turn = messages.slice(userIndex);
  const userRequest = extractText(turn[0].message.content).trim();
  let assistantConclusion = "";
  const modifiedFiles = new Set<string>();

  for (const entry of turn) {
    if (entry.message.role !== "assistant") continue;
    for (const block of entry.message.content) {
      if (block.type !== "toolCall") continue;
      if (block.name !== "edit" && block.name !== "write") continue;
      const filePath = block.arguments?.path;
      if (typeof filePath === "string") modifiedFiles.add(filePath);
    }
  }

  for (let index = turn.length - 1; index >= 0; index--) {
    const message = turn[index].message;
    if (message.role !== "assistant") continue;
    const text = extractText(message.content).trim();
    if (text) {
      assistantConclusion = text;
      break;
    }
  }

  if (!assistantConclusion) return null;

  return {
    userRequest,
    assistantConclusion,
    modifiedFiles: [...modifiedFiles].sort(),
  };
}

function buildReviewPrompt(
  reviewRequest: string,
  packet: ReviewPacket,
): string {
  const sections = [
    "<review_packet>",
    "## Review instructions",
    reviewRequest,
    "",
    "## Last user requirement",
    packet.userRequest || "(No textual user requirement was available.)",
    "",
    "## Main agent final conclusion",
    packet.assistantConclusion,
  ];

  if (packet.modifiedFiles.length > 0) {
    sections.push("", "## Files produced or modified");
    for (const filePath of packet.modifiedFiles) {
      sections.push(`- \`${filePath}\``);
    }
  }

  sections.push(
    "</review_packet>",
    "",
    "Inspect the repository independently with your tools. Do not trust the main agent's claims without verification.",
  );
  return sections.join("\n");
}

function buildSessionName(mainSessionId: string, behavior: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `minifork-${behavior}-${mainSessionId.slice(0, 8)}-${stamp}`;
}

function createProgressReporter(
  ctx: ExtensionCommandContext,
  reviewer: { provider: string; modelId: string },
  sessionName: string,
) {
  const items: string[] = [];
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const render = () => {
    refreshTimer = undefined;
    if (disposed) return;
    ctx.ui.setWidget(
      "minifork",
      [
        `Mini-fork · ${reviewer.provider}/${reviewer.modelId}`,
        `Session · ${sessionName}`,
        ...items.slice(-MAX_PROGRESS_ITEMS),
        "Use /minifork-abort to stop",
      ],
      { placement: "belowEditor" },
    );
  };

  const scheduleRender = () => {
    if (disposed || refreshTimer) return;
    refreshTimer = setTimeout(render, 50);
  };

  return {
    add(text: string) {
      items.push(text);
      scheduleRender();
    },
    dispose() {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = undefined;
    },
  };
}

type ProgressReporter = ReturnType<typeof createProgressReporter>;

function getReviewerToolsPath(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.join(here, "minifork-support", "reviewer-tools.ts");
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // fall through to homedir fallback
  }
  return path.join(
    os.homedir(),
    ".pi",
    "agent",
    "extensions",
    "minifork-support",
    "reviewer-tools.ts",
  );
}

function getAgentPresetsExtensionPath(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.join(here, "agent-presets.ts");
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // fall through to homedir fallback
  }
  return path.join(
    os.homedir(),
    ".pi",
    "agent",
    "extensions",
    "agent-presets.ts",
  );
}

function spawnReviewer(options: {
  cwd: string;
  reviewer: { provider: string; modelId: string };
  behavior: BehaviorDefinition;
  prompt: string;
  sessionName: string;
  thinkingLevel: string;
}): ChildProcessWithoutNullStreams {
  const reviewerToolsPath = getReviewerToolsPath();
  const agentPresetsPath = getAgentPresetsExtensionPath();
  const args = [
    "--mode",
    "rpc",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
    "-e",
    agentPresetsPath,
    "-e",
    reviewerToolsPath,
    "--tools",
    REVIEWER_TOOLS.join(","),
    "--model",
    `${options.reviewer.provider}/${options.reviewer.modelId}`,
    "--thinking",
    options.thinkingLevel,
    "--name",
    options.sessionName,
    "--system-prompt",
    MINIFORK_SAFETY_PROMPT,
  ];
  const invocation = getPiInvocation(args);
  return spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    shell: false,
    env: {
      ...process.env,
      PI_AGENT_PRESET: "",
      PI_AGENT_BEHAVIOR: options.behavior.name,
      PI_AGENT_BEHAVIOR_PATH: options.behavior.filePath,
      PI_MINIFORK: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function trackReviewer(
  child: ChildProcessWithoutNullStreams,
  options: {
    prompt: string;
    progress: ProgressReporter;
  },
): Promise<ReviewerResult> {
  return new Promise<ReviewerResult>((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let stdoutBuffer = "";
    let stderr = "";
    let lastAssistantText = "";
    let sessionFile: string | undefined;
    let settled = false;

    const timeout = setTimeout(() => {
      fail(new Error("Reviewer timed out after 30 minutes"));
    }, CHILD_TIMEOUT_MS);

    const settle = (
      action: () => void,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      action();
    };

    const finish = () =>
      settle(() => {
        safeEndStdin(child);
        setTimeout(() => terminateChild(child), 1000).unref();
        if (!lastAssistantText.trim()) {
          reject(
            new Error("Reviewer completed without a final text response"),
          );
          return;
        }
        resolve({ text: lastAssistantText.trim(), sessionFile });
      });

    const fail = (error: Error) =>
      settle(() => {
        terminateChild(child);
        reject(error);
      });

    const send = (command: Record<string, unknown>) => {
      if (settled) return;
      if (child.stdin.destroyed || !child.stdin.writable) {
        fail(new Error("Reviewer RPC stdin closed unexpectedly"));
        return;
      }
      try {
        child.stdin.write(`${JSON.stringify(command)}\n`);
      } catch (error) {
        fail(
          new Error(
            `Reviewer stdin write failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    };

    const processResponse = (event: RpcResponse) => {
      if (!event.success) {
        fail(new Error(event.error || `${event.command} RPC command failed`));
        return;
      }
      if (event.id === "minifork-state") {
        const value = event.data?.sessionFile;
        if (typeof value === "string") sessionFile = value;
      }
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        options.progress.add("Ignoring malformed reviewer event");
        return;
      }

      if (event.type === "response") {
        processResponse(event as unknown as RpcResponse);
        return;
      }

      if (event.type === "extension_ui_request") {
        handleExtensionUiRequest(event, send);
        return;
      }

      if (event.type === "tool_execution_start") {
        const toolName =
          typeof event.toolName === "string" ? event.toolName : "tool";
        const args = isRecord(event.args) ? event.args : {};
        options.progress.add(`→ ${formatToolCall(toolName, args)}`);
        return;
      }

      if (event.type === "tool_execution_end") {
        const toolName =
          typeof event.toolName === "string" ? event.toolName : "tool";
        options.progress.add(`${event.isError ? "✗" : "✓"} ${toolName}`);
        return;
      }

      if (event.type === "message_end" && isRecord(event.message)) {
        const message = event.message;
        if (message.role === "assistant") {
          const text = extractText(message.content).trim();
          if (text) lastAssistantText = text;
        }
        return;
      }

      if (event.type === "extension_error") {
        const error =
          typeof event.error === "string"
            ? event.error
            : "unknown extension error";
        options.progress.add(`Extension warning: ${error}`);
        return;
      }

      if (event.type === "agent_settled") {
        options.progress.add("Reviewer finished");
        finish();
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += decoder.write(chunk);
      while (true) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        let line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        processLine(line);
      }
    });

    child.stdout.on("end", () => {
      stdoutBuffer += decoder.end();
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
    });

    child.stdin.on("error", (error) => {
      fail(
        new Error(
          `Reviewer stdin stream error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });

    child.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));

    child.on("close", (code) => {
      if (settled) return;
      const detail = stderr.trim() || `exit code ${code ?? "unknown"}`;
      fail(new Error(`Reviewer process exited early: ${detail}`));
    });

    child.on("spawn", () => {
      send({ id: "minifork-state", type: "get_state" });
      send({ id: "minifork-prompt", type: "prompt", message: options.prompt });
    });
  });
}

function handleExtensionUiRequest(
  event: Record<string, unknown>,
  send: (command: Record<string, unknown>) => void,
) {
  const id = event.id;
  const method = event.method;
  if (typeof id !== "string" || typeof method !== "string") return;

  if (method === "confirm") {
    send({ type: "extension_ui_response", id, confirmed: false });
    return;
  }

  if (["select", "input", "editor"].includes(method)) {
    send({ type: "extension_ui_response", id, cancelled: true });
  }
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const executable = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

function terminateChild(child: ChildProcessWithoutNullStreams | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 5000).unref();
}

function safeEndStdin(child: ChildProcessWithoutNullStreams): void {
  try {
    child.stdin.end();
  } catch {
    // stdin already closed; safe to ignore
  }
}

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
): string {
  if (toolName === "review_git") {
    const action = args.action ?? "";
    const ref = args.ref ?? "";
    return ref
      ? `git ${action} ${truncate(String(ref), 60)}`
      : `git ${action}`;
  }
  if (["read", "write", "edit", "grep", "find", "ls"].includes(toolName)) {
    const target = args.path ?? args.pattern ?? "";
    return `${toolName} ${truncate(String(target), 100)}`.trim();
  }
  return `${toolName} ${truncate(JSON.stringify(args), 100)}`.trim();
}

function buildReviewMessage(
  reviewer: { provider: string; modelId: string },
  behavior: string,
  request: string,
  result: ReviewerResult,
): string {
  const lines = [
    "## Mini-fork Review",
    `**Reviewer:** ${reviewer.provider}/${reviewer.modelId}`,
    `**Behavior:** ${behavior}`,
    `**Request:** ${request}`,
  ];
  if (result.sessionFile) {
    lines.push(`**Review session:** \`${result.sessionFile}\``);
  }
  lines.push("", result.text);
  return lines.join("\n");
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
}
