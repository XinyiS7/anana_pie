/**
 * /abstract — 本地消息瘦身摘要
 *
 * 手动触发的命令，将当前对话历史压缩为 "usr-msg + ai-last-reply" 格式。
 * 不调 LLM，纯本地处理。默认的 /compact 行为不受影响。
 *
 * 策略：通过 session_before_compact hook 拦截，仅在 /abstract 时生效。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

const RECENT_TURNS = 3;
const ABSTRACT_TRIGGER = "__pi_lean_abstract_v1__";

export default function (pi: ExtensionAPI) {
  // Hook: 只在 /abstract 触发时接管压缩
  pi.on("session_before_compact", async (event, ctx) => {
    if (event.customInstructions !== ABSTRACT_TRIGGER) return;

    const abstract = prepareAbstract(event.branchEntries);
    if (!abstract) {
      ctx.ui.notify("Nothing new to abstract", "info");
      return { cancel: true };
    }

    const summary = buildAbstractSummary(
      abstract.oldMessages,
      abstract.previousSummary
    );
    if (!summary.trim()) return { cancel: true };

    const msgLabel = abstract.previousSummary ? "new messages" : "messages";
    ctx.ui.notify(
      `Abstracted ${abstract.oldMessages.length} ${msgLabel} → ${summary.length} chars`,
      "info"
    );

    return {
      compaction: {
        summary,
        firstKeptEntryId: abstract.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: {
          abstractVersion: 1,
          readFiles: [] as string[],
          modifiedFiles: collectModifiedFiles(abstract.oldMessages),
        },
      },
    };
  });

  // 注册 /abstract 命令
  pi.registerCommand("abstract", {
    description: "瘦身压缩：保留最近3轮，历史精简为 usr-msg + ai-last-reply",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the agent to finish first", "warning");
        return;
      }

      const abstract = prepareAbstract(ctx.sessionManager.getBranch());
      if (!abstract) {
        ctx.ui.notify(
          `Need more than ${RECENT_TURNS} new turns to abstract`,
          "info"
        );
        return;
      }

      ctx.ui.notify("Abstracting...", "info");

      // 借用 compaction 落盘机制；专属 marker 确保普通 /compact 不被接管
      ctx.compact({
        customInstructions: ABSTRACT_TRIGGER,
        onComplete: (_result) => {
          ctx.ui.notify("Abstract applied. Use /tree to browse history.", "info");
        },
        onError: (err) => {
          ctx.ui.notify(`Abstract failed: ${err.message}`, "error");
        },
      });
    },
  });
}

// ── 瘦身逻辑 ──

interface AbstractPreparation {
  oldMessages: SessionMessageEntry[];
  firstKeptEntryId: string;
  previousSummary?: string;
}

function prepareAbstract(entries: SessionEntry[]): AbstractPreparation | null {
  let messageEntries = entries.filter(
    (e): e is SessionMessageEntry => e.type === "message"
  );

  const lastCompaction = [...entries]
    .reverse()
    .find((e) => e.type === "compaction");

  if (lastCompaction?.type === "compaction") {
    const startFrom = messageEntries.findIndex(
      (e) => e.id === lastCompaction.firstKeptEntryId
    );
    if (startFrom >= 0) messageEntries = messageEntries.slice(startFrom);
  }

  let userCount = 0;
  let boundaryIndex = -1;
  for (let i = messageEntries.length - 1; i >= 0; i--) {
    if (messageEntries[i].message.role !== "user") continue;
    userCount++;
    if (userCount === RECENT_TURNS) {
      boundaryIndex = i;
      break;
    }
  }

  if (boundaryIndex <= 0) return null;

  return {
    oldMessages: messageEntries.slice(0, boundaryIndex),
    firstKeptEntryId: messageEntries[boundaryIndex].id,
    previousSummary:
      lastCompaction?.type === "compaction"
        ? lastCompaction.summary
        : undefined,
  };
}

function buildAbstractSummary(
  entries: SessionMessageEntry[],
  previousSummary?: string
): string {
  const turns = groupIntoTurns(entries);
  const lines: string[] = [];

  // 最近一次 summary 已经累计包含更早历史，原样保留一次即可
  if (previousSummary) {
    lines.push("## Prior Abstract");
    lines.push(previousSummary);
    lines.push("");
  }

  lines.push("## Abstracted History");
  lines.push("");

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    lines.push(`### Turn ${i + 1}`);
    lines.push("");

    const userText = extractTextContent(turn.userMessage.message.content);
    lines.push(`**User:** ${userText}`);
    lines.push("");

    const slimmed = turn.assistantMessages
      .map((e) => slimAssistantMessage(e.message))
      .filter(Boolean);

    if (slimmed.length > 0) {
      lines.push(`**Assistant:** ${slimmed.join("\n\n")}`);
    }

    const files = collectModifiedFiles(turn.assistantMessages);
    if (files.length > 0) {
      lines.push(`  _Modified:_ ${files.join(", ")}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

interface Turn {
  userMessage: SessionMessageEntry;
  assistantMessages: SessionMessageEntry[];
}

function groupIntoTurns(entries: SessionMessageEntry[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const entry of entries) {
    if (entry.message.role === "user") {
      if (current) turns.push(current);
      current = { userMessage: entry, assistantMessages: [] };
    } else if (current) {
      current.assistantMessages.push(entry);
    }
  }
  if (current) turns.push(current);
  return turns;
}

function extractTextContent(
  content: string | Array<{ type: string; [key: string]: unknown }>
): string {
  if (typeof content === "string") return content.trim();
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function slimAssistantMessage(
  message: SessionMessageEntry["message"]
): string | null {
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return null;

  const texts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text" && typeof (block as any).text === "string") {
      const cleaned = stripCodeBlocks((block as any).text);
      if (cleaned.trim()) texts.push(cleaned.trim());
    }
  }
  return texts.join(" ").trim() || null;
}

function stripCodeBlocks(text: string): string {
  let result = text.replace(/```[\s\S]*?```/g, "[code]");
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

function collectModifiedFiles(entries: SessionMessageEntry[]): string[] {
  const files = new Set<string>();
  for (const entry of entries) {
    const content = entry.message.content;
    if (typeof content === "string" || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== "toolCall") continue;
      const tc = block as { name: string; arguments: Record<string, unknown> };
      if (
        (tc.name === "edit" || tc.name === "write") &&
        typeof tc.arguments?.path === "string"
      ) {
        files.add(tc.arguments.path);
      }
    }
  }
  return [...files].sort();
}
