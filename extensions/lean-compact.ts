import { contentText, uuidv7, type Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  buildDetails,
  prepareArchive,
  renderCompactionSummary,
  validateBoundary,
  type PreparedArchive,
} from "./lean-compact-support/core.js";

const ABSTRACT_TRIGGER = "__pi_dialogue_abstract_v2__";
const PROACTIVE_THRESHOLD_TOKENS = 200_000;
const PROACTIVE_MAX_CONTEXT_WINDOW = 300_000;
const SEMANTIC_SUMMARY_MAX_TOKENS = 8_192;
// Semantic compression never runs on the session model. The summarization prompt
// is a re-serialized text blob with its own system prompt, so it cannot reuse the
// conversation's prompt cache (measured: ~0.2% cache reads across 106 native
// compactions) — paying a premium pane model for it buys nothing. Direct-connection
// deepseek-flash is the cheap default. The session model stays as the fallback
// because a throw here cancels the entire compaction, including the auto-compaction
// that fires mid-run on short-window panes.
const COMPRESSION_MODEL_PROVIDER = "deepseek";
const COMPRESSION_MODEL_ID = "deepseek-flash";

interface CompactionRequestState {
  generation: number;
  sessionKey: string;
  leafId: string | null;
  source: "manual" | "proactive";
}

interface SemanticCompressionResult {
  text: string;
  usage: Usage;
}

export default function dialoguePreservingCompaction(pi: ExtensionAPI) {
  let generation = 0;
  let sessionKey = "";
  let compactionRequest: CompactionRequestState | undefined;
  let hookToken: symbol | undefined;
  let failedLeafId: string | null | undefined;

  const currentSessionKey = (ctx: ExtensionContext): string =>
    ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();

  const requestCompaction = (
    ctx: ExtensionContext,
    source: CompactionRequestState["source"],
  ): boolean => {
    if (compactionRequest || hookToken) {
      if (source === "manual") {
        ctx.ui.notify("Dialogue compaction is already running", "warning");
      }
      return false;
    }

    const request: CompactionRequestState = {
      generation,
      sessionKey: currentSessionKey(ctx),
      leafId: ctx.sessionManager.getLeafId(),
      source,
    };
    compactionRequest = request;

    ctx.compact({
      customInstructions: ABSTRACT_TRIGGER,
      onComplete: (result) => {
        if (!isCurrentRequest(request)) return;
        compactionRequest = undefined;
        failedLeafId = undefined;
        const details = result.details as { semanticCompressed?: boolean; archivedTurnCount?: number } | undefined;
        ctx.ui.notify(
          `Dialogue compacted: ${result.tokensBefore.toLocaleString()} tokens before, ` +
            `${details?.archivedTurnCount ?? "?"} archived turn(s), ` +
            `semantic compression ${details?.semanticCompressed ? "used" : "not needed"}.`,
          "info",
        );
      },
      onError: (error) => {
        if (!isCurrentRequest(request)) return;
        compactionRequest = undefined;
        failedLeafId = request.leafId;
        ctx.ui.notify(`Dialogue compaction failed: ${error.message}`, "error");
      },
    });
    return true;
  };

  const isCurrentRequest = (request: CompactionRequestState): boolean =>
    generation === request.generation &&
    sessionKey === request.sessionKey &&
    compactionRequest === request;

  pi.on("session_start", (_event, ctx) => {
    generation += 1;
    sessionKey = currentSessionKey(ctx);
    compactionRequest = undefined;
    hookToken = undefined;
    failedLeafId = undefined;
  });

  pi.on("session_shutdown", () => {
    generation += 1;
    sessionKey = "";
    compactionRequest = undefined;
    hookToken = undefined;
    failedLeafId = undefined;
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (hookToken) {
      ctx.ui.notify("Duplicate compaction request cancelled", "warning");
      return { cancel: true };
    }
    if (compactionRequest && event.customInstructions !== ABSTRACT_TRIGGER) {
      ctx.ui.notify("Competing compaction request cancelled", "warning");
      return { cancel: true };
    }

    const token = Symbol("dialogue-compaction-hook");
    hookToken = token;
    const hookGeneration = generation;
    const hookSessionKey = currentSessionKey(ctx);
    const preparedLeafId = event.branchEntries.at(-1)?.id ?? null;

    try {
      const preparation = event.preparation;
      if (ctx.sessionManager.getLeafId() !== preparedLeafId) {
        throw new Error("Active leaf changed before compaction preparation could be consumed");
      }
      if (
        preparation.messagesToSummarize.length === 0 &&
        preparation.turnPrefixMessages.length === 0
      ) {
        throw new Error("Pi preparation contains no messages to compact");
      }
      if (preparation.isSplitTurn !== (preparation.turnPrefixMessages.length > 0)) {
        throw new Error("Pi split-turn preparation is internally inconsistent");
      }

      const archive = prepareArchive(
        event.branchEntries,
        preparation.firstKeptEntryId,
        preparation.isSplitTurn,
      );

      let semanticResult: SemanticCompressionResult | undefined;
      if (archive.needsSemanticCompression) {
        semanticResult = await compressOlderDialogue(archive, event.signal, ctx);
      }

      const currentBranch = ctx.sessionManager.getBranch();
      if (
        generation !== hookGeneration ||
        currentSessionKey(ctx) !== hookSessionKey ||
        ctx.sessionManager.getLeafId() !== preparedLeafId ||
        currentBranch.at(-1)?.id !== preparedLeafId ||
        event.signal.aborted
      ) {
        throw new Error("Compaction became stale or was aborted before persistence");
      }
      validateBoundary(
        currentBranch,
        preparation.firstKeptEntryId,
        preparation.isSplitTurn,
      );

      const summary = renderCompactionSummary(archive, semanticResult?.text);
      if (!summary.trim()) throw new Error("Dialogue compaction produced an empty checkpoint");

      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage: semanticResult?.usage,
          details: buildDetails(archive, Boolean(semanticResult)),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedLeafId = ctx.sessionManager.getLeafId();
      ctx.ui.notify(`Dialogue compaction cancelled: ${message}`, "error");
      return { cancel: true };
    } finally {
      if (hookToken === token) hookToken = undefined;
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (
      !usage ||
      usage.tokens === null ||
      !Number.isFinite(usage.tokens) ||
      usage.contextWindow > PROACTIVE_MAX_CONTEXT_WINDOW ||
      usage.tokens < PROACTIVE_THRESHOLD_TOKENS ||
      compactionRequest ||
      hookToken
    ) {
      return;
    }

    const leafId = ctx.sessionManager.getLeafId();
    if (failedLeafId === leafId) return;
    requestCompaction(ctx, "proactive");
  });

  pi.registerCommand("abstract", {
    description: "Preserve dialogue, remove tool noise, and compact the current session",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the agent to finish before /abstract", "warning");
        return;
      }
      failedLeafId = undefined;
      if (requestCompaction(ctx, "manual")) {
        ctx.ui.notify("Building a dialogue-preserving checkpoint...", "info");
      }
    },
  });
}

async function compressOlderDialogue(
  archive: PreparedArchive,
  signal: AbortSignal,
  ctx: ExtensionContext,
): Promise<SemanticCompressionResult> {
  const sessionModel = ctx.model;
  const preferred = ctx.modelRegistry.find(COMPRESSION_MODEL_PROVIDER, COMPRESSION_MODEL_ID);
  const primary = preferred ?? sessionModel;
  if (!primary) throw new Error("No model is available for semantic compression");

  const run = async (
    model: NonNullable<typeof primary>,
  ): Promise<SemanticCompressionResult> => {
    const response = await ctx.modelRegistry.complete(
      model,
      {
        systemPrompt:
          "You compress earlier dialogue for a coding-session checkpoint. Preserve user intent, " +
          "decisions, constraints, acceptance verdicts, unresolved questions, exact identifiers, and " +
          "cross-agent handoffs. Do not continue the conversation. Do not invent file changes or outcomes.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Semantically compress only the earlier dialogue below. The latest three turns are " +
                  "kept verbatim elsewhere. Return concise Markdown reference context, not a response " +
                  `to the speakers.\n\n<earlier-dialogue>\n${archive.olderDialogue}\n</earlier-dialogue>`,
              },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: SEMANTIC_SUMMARY_MAX_TOKENS,
        signal,
        cacheRetention: "none",
        sessionId: uuidv7(),
      },
    );

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || `Semantic compression stopped: ${response.stopReason}`);
    }
    const text = contentText(response.content).trim();
    if (!text) throw new Error("Semantic compression returned empty text");
    return { text, usage: response.usage };
  };

  try {
    return await run(primary);
  } catch (error) {
    if (!preferred || !sessionModel || sessionModel === primary || signal.aborted) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(
      `Semantic compression fell back to ${sessionModel.provider}/${sessionModel.id}: ${reason}`,
      "warning",
    );
    return await run(sessionModel);
  }
}
