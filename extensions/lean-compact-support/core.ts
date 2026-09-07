import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const DIALOGUE_COMPACTION_VERSION = 2;
export const DEFAULT_DIALOGUE_BUDGET_TOKENS = 30_000;
export const RECENT_VERBATIM_TURNS = 3;
export const RECENT_EVIDENCE_TURNS = 2;
export const SUBAGENT_RESULT_MAX_CHARS = 8_000;
export const ERROR_RESULT_MAX_CHARS = 4_000;

export interface DialogueTurn {
  id: string;
  userText: string;
  assistantTexts: string[];
  messages: AgentMessage[];
  referencedFiles: string[];
  complete: boolean;
}

export interface PreparedArchive {
  turns: DialogueTurn[];
  referencedFiles: string[];
  recentChanges: string[];
  recentExternalResults: string[];
  needsSemanticCompression: boolean;
  fullDialogue: string;
  olderDialogue: string;
  recentDialogue: string;
  archivedThroughEntryId: string;
}

export interface DialogueCompactionDetails {
  dialogueCompactionVersion: 2;
  archivedThroughEntryId: string;
  archivedTurnCount: number;
  referencedFiles: string[];
  semanticCompressed: boolean;
  recentChangeCount: number;
  recentExternalResultCount: number;
}

interface NormalizedUserText {
  text: string;
  referencedFiles: string[];
}

interface ToolCallLike {
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface ToolResultLike {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: unknown;
  isError: boolean;
}

export function prepareArchive(
  branchEntries: SessionEntry[],
  firstKeptEntryId: string,
  isSplitTurn: boolean,
  dialogueBudgetTokens = DEFAULT_DIALOGUE_BUDGET_TOKENS,
): PreparedArchive {
  const boundaryIndex = validateBoundary(branchEntries, firstKeptEntryId, isSplitTurn);
  const archivedEntries = branchEntries.slice(0, boundaryIndex);
  const turns = extractDialogueTurns(archivedEntries, isSplitTurn);
  if (turns.length === 0) {
    throw new Error("No dialogue turns exist before the prepared compaction boundary");
  }

  const fullDialogue = renderTurns(turns);
  const referencedFiles = uniqueInOrder(turns.flatMap((turn) => turn.referencedFiles));
  const evidenceTurns = turns.filter((turn) => turn.complete).slice(-RECENT_EVIDENCE_TURNS);
  const recentChanges = extractRecentChanges(evidenceTurns);
  const recentExternalResults = extractRecentExternalResults(evidenceTurns);
  const needsSemanticCompression = estimateTokens(fullDialogue) > dialogueBudgetTokens;

  let olderDialogue = "";
  let recentDialogue = fullDialogue;
  if (needsSemanticCompression) {
    const completeTurns = turns.filter((turn) => turn.complete);
    const recentIds = new Set(
      completeTurns.slice(-RECENT_VERBATIM_TURNS).map((turn) => turn.id),
    );
    for (const turn of turns) {
      if (!turn.complete) recentIds.add(turn.id);
    }
    const olderTurns = turns.filter((turn) => !recentIds.has(turn.id));
    const recentTurns = turns.filter((turn) => recentIds.has(turn.id));
    if (olderTurns.length === 0) {
      throw new Error("Dialogue exceeds budget but has no older turns eligible for semantic compression");
    }
    olderDialogue = renderTurns(olderTurns);
    recentDialogue = renderTurns(recentTurns);
  }

  return {
    turns,
    referencedFiles,
    recentChanges,
    recentExternalResults,
    needsSemanticCompression,
    fullDialogue,
    olderDialogue,
    recentDialogue,
    archivedThroughEntryId: archivedEntries[archivedEntries.length - 1]?.id ?? firstKeptEntryId,
  };
}

export function renderCompactionSummary(
  archive: PreparedArchive,
  semanticHistory?: string,
): string {
  if (archive.needsSemanticCompression && !semanticHistory?.trim()) {
    throw new Error("Semantic history is required for an over-budget dialogue archive");
  }

  const sections = ["# Dialogue-Preserving Context Checkpoint"];
  if (archive.needsSemanticCompression) {
    sections.push("## Earlier Dialogue (Semantic Compression)", semanticHistory!.trim());
    sections.push("## Recent Dialogue (Verbatim)", archive.recentDialogue);
  } else {
    sections.push("## Dialogue Archive (Verbatim)", archive.fullDialogue);
  }

  sections.push(
    "## Recent File Changes (Last Two Archived Turns)",
    archive.recentChanges.length > 0
      ? archive.recentChanges.map((item) => `- ${item}`).join("\n")
      : "(none recorded)",
  );

  if (archive.recentExternalResults.length > 0) {
    sections.push("## Recent External Results", archive.recentExternalResults.join("\n\n"));
  }

  if (archive.referencedFiles.length > 0) {
    sections.push(
      "## Referenced Files Requested by the User",
      archive.referencedFiles.map((path) => `- ${path}`).join("\n"),
    );
  }

  return sections.join("\n\n");
}

export function buildDetails(
  archive: PreparedArchive,
  semanticCompressed: boolean,
): DialogueCompactionDetails {
  return {
    dialogueCompactionVersion: DIALOGUE_COMPACTION_VERSION,
    archivedThroughEntryId: archive.archivedThroughEntryId,
    archivedTurnCount: archive.turns.length,
    referencedFiles: [...archive.referencedFiles],
    semanticCompressed,
    recentChangeCount: archive.recentChanges.length,
    recentExternalResultCount: archive.recentExternalResults.length,
  };
}

export function extractDialogueTurns(
  entries: SessionEntry[],
  finalTurnIsSplit = false,
): DialogueTurn[] {
  const turns: DialogueTurn[] = [];
  let current: DialogueTurn | undefined;

  const finishCurrent = (complete: boolean) => {
    if (!current) return;
    current.complete = complete;
    turns.push(current);
    current = undefined;
  };

  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "user") {
        finishCurrent(true);
        const normalized = normalizeUserText(extractTextContent(message.content));
        current = {
          id: entry.id,
          userText: normalized.text,
          assistantTexts: [],
          messages: [message],
          referencedFiles: normalized.referencedFiles,
          complete: false,
        };
        continue;
      }

      if (!current) continue;
      current.messages.push(message);
      if (message.role === "assistant") {
        current.assistantTexts.push(...extractAssistantTexts(message));
      }
      continue;
    }

    if (entry.type === "custom_message") {
      finishCurrent(true);
      const normalized = normalizeUserText(extractTextContent(entry.content));
      current = {
        id: entry.id,
        userText: `[Custom message: ${entry.customType}]\n${normalized.text}`,
        assistantTexts: [],
        messages: [],
        referencedFiles: normalized.referencedFiles,
        complete: false,
      };
      continue;
    }

    if (entry.type === "branch_summary") {
      finishCurrent(true);
      current = {
        id: entry.id,
        userText: `[Branch summary]\n${entry.summary}`,
        assistantTexts: [],
        messages: [],
        referencedFiles: [],
        complete: false,
      };
    }
  }

  finishCurrent(!finalTurnIsSplit);
  return turns;
}

export function normalizeUserText(text: string): NormalizedUserText {
  const referencedFiles: string[] = [];
  let rendered = text.replace(
    /<file\b[^>]*\bname="([^"]+)"[^>]*>[\s\S]*?<\/file>/gi,
    (_match, path: string) => {
      referencedFiles.push(path);
      return `[Referenced file: ${path}]`;
    },
  );

  rendered = rendered.replace(
    /<skill\b[^>]*\bname="([^"]+)"[^>]*>[\s\S]*?<\/skill>/gi,
    (_match, name: string) => `[Invoked skill: ${name}]`,
  );

  for (const match of rendered.matchAll(
    /(^|[\s(])@(?:"([^"]+)"|'([^']+)'|([^\s,;]+))/g,
  )) {
    const candidate = stripTrailingReferencePunctuation(match[2] ?? match[3] ?? match[4] ?? "");
    if (looksLikeFileReference(candidate)) referencedFiles.push(candidate);
  }

  return { text: rendered, referencedFiles: uniqueInOrder(referencedFiles) };
}

export function renderTurns(turns: DialogueTurn[]): string {
  return turns
    .map((turn, index) => {
      const sections = [`### Turn ${index + 1}`, "#### User", turn.userText];
      if (turn.assistantTexts.length > 0) {
        sections.push("#### Assistant", turn.assistantTexts.join("\n\n"));
      }
      if (!turn.complete) sections.push("_[split-turn prefix; raw suffix remains after this checkpoint]_");
      return sections.join("\n\n");
    })
    .join("\n\n---\n\n");
}

export function extractRecentChanges(turns: DialogueTurn[]): string[] {
  const changes: string[] = [];
  for (const turn of turns) {
    const results = toolResultsByCallId(turn.messages);
    for (const message of turn.messages) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        const call = block as ToolCallLike;
        const result = call.id ? results.get(call.id) : undefined;
        if (!result || result.isError) continue;
        changes.push(...describeSuccessfulMutation(call));
      }
    }
  }
  return uniqueInOrder(changes);
}

export function extractRecentExternalResults(turns: DialogueTurn[]): string[] {
  const results: string[] = [];
  for (const turn of turns) {
    for (const message of turn.messages) {
      if (message.role !== "toolResult") continue;
      const toolResult = message as ToolResultLike;
      if (toolResult.toolName !== "subagent" && !toolResult.isError) continue;
      const maxChars = toolResult.toolName === "subagent"
        ? SUBAGENT_RESULT_MAX_CHARS
        : ERROR_RESULT_MAX_CHARS;
      const text = extractTextContent(toolResult.content);
      if (!text.trim()) continue;
      const label = toolResult.isError
        ? `### ${toolResult.toolName} error`
        : `### ${toolResult.toolName}`;
      results.push(`${label}\n${truncateWithMarker(text, maxChars)}`);
    }
  }
  return results;
}

export function validateBoundary(
  branchEntries: SessionEntry[],
  firstKeptEntryId: string,
  isSplitTurn: boolean,
): number {
  const boundaryIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (boundaryIndex <= 0) {
    throw new Error(`Prepared firstKeptEntryId is missing or has no archivable prefix: ${firstKeptEntryId}`);
  }
  const boundary = branchEntries[boundaryIndex];
  if (boundary.type === "message" && boundary.message.role === "toolResult") {
    throw new Error("Prepared compaction boundary points at an orphan-prone tool result");
  }
  if (isSplitTurn && boundary.type !== "message") {
    throw new Error("Split-turn compaction boundary must point at a message entry");
  }
  return boundaryIndex;
}

export function estimateTokens(text: string): number {
  let estimate = 0;
  for (const character of text) {
    if (/^[\x00-\x7F]$/.test(character)) {
      estimate += 0.25;
    } else if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(character)) {
      estimate += 1;
    } else {
      estimate += 0.5;
    }
  }
  return Math.ceil(estimate);
}

function describeSuccessfulMutation(call: ToolCallLike): string[] {
  const name = call.name;
  const args = call.arguments ?? {};
  const path = typeof args.path === "string" ? args.path : undefined;
  if (name === "edit" && path) {
    const edits = normalizeEdits(args);
    if (edits.length === 0) return [`M ${path} — edit completed (replacement details unavailable)`];
    const descriptions = edits.slice(0, 3).map(({ oldText, newText }) =>
      `“${firstMeaningfulLine(oldText)}” → “${firstMeaningfulLine(newText)}”`,
    );
    const extra = edits.length > 3 ? `; +${edits.length - 3} more replacement(s)` : "";
    return [`M ${path} — ${edits.length} replacement(s): ${descriptions.join("; ")}${extra}`];
  }

  if (name === "write" && path) {
    const content = typeof args.content === "string" ? args.content : "";
    const opening = firstMeaningfulLine(content);
    const suffix = opening ? `; begins “${opening}”` : "";
    return [`W ${path} — wrote ${content.length.toLocaleString("en-US")} chars${suffix}`];
  }

  if (name === "bash" && typeof args.command === "string") {
    return describeSimpleShellMutations(args.command);
  }

  return [];
}

function describeSimpleShellMutations(command: string): string[] {
  const changes: string[] = [];
  for (const rawLine of command.split(/\r?\n/)) {
    for (const rawSegment of rawLine.split(/\s*&&\s*/)) {
      const line = rawSegment.trim();
      if (!line || /[|;<>]/.test(line)) continue;
      const tokens = tokenizeSimpleShell(line);
      if (tokens.length === 0) continue;

      let commandIndex = 0;
      let verb = tokens[0];
      if (verb === "git" && (tokens[1] === "rm" || tokens[1] === "mv")) {
        commandIndex = 1;
        verb = tokens[1];
      }
      const operands = tokens
        .slice(commandIndex + 1)
        .filter((token) => token !== "--" && !token.startsWith("-"));

      if (verb === "rm" && operands.length === 1 && !tokens.includes("--cached")) {
        changes.push(`D ${operands[0]} — successful simple remove command`);
      } else if (verb === "mv" && operands.length === 2) {
        changes.push(`R ${operands[0]} → ${operands[1]} — successful simple rename/move command`);
      } else if (verb === "rm" || verb === "mv") {
        changes.push(`CMD — successful mutation command (operation not safely classified): ${truncateInline(line, 180)}`);
      }
    }
  }
  return changes;
}

function normalizeEdits(args: Record<string, unknown>): Array<{ oldText: string; newText: string }> {
  const edits: Array<{ oldText: string; newText: string }> = [];
  if (Array.isArray(args.edits)) {
    for (const value of args.edits) {
      if (!value || typeof value !== "object") continue;
      const edit = value as Record<string, unknown>;
      if (typeof edit.oldText === "string" && typeof edit.newText === "string") {
        edits.push({ oldText: edit.oldText, newText: edit.newText });
      }
    }
  }
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    edits.push({ oldText: args.oldText, newText: args.newText });
  }
  return edits;
}

function toolResultsByCallId(messages: AgentMessage[]): Map<string, ToolResultLike> {
  const results = new Map<string, ToolResultLike>();
  for (const message of messages) {
    if (message.role === "toolResult") {
      const result = message as ToolResultLike;
      results.set(result.toolCallId, result);
    }
  }
  return results;
}

function extractAssistantTexts(message: AgentMessage): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content
    .filter((block): block is { type: "text"; text: string } =>
      block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
    )
    .map((block) => block.text);
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(block) && typeof block === "object" && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function firstMeaningfulLine(text: string): string {
  const line = text.split(/\r?\n/).find((value) => value.trim().length > 0)?.trim() ?? "";
  return truncateInline(line, 120);
}

function truncateInline(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function truncateWithMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} chars truncated]`;
}

function tokenizeSimpleShell(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3],
  );
}

function stripTrailingReferencePunctuation(value: string): string {
  return value.replace(/[)\]}>.!?]+$/g, "");
}

function looksLikeFileReference(value: string): boolean {
  if (!value || value.includes("@")) return false;
  return (
    /[\\/]/.test(value) ||
    /\.[A-Za-z0-9_-]{1,12}$/.test(value) ||
    /^(?:README|LICENSE|COPYING|Makefile|Dockerfile|Containerfile|Procfile)$/i.test(value)
  );
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
