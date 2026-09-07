/**
 * Bash Guard — safe shell for agent presets
 *
 * Intercepts the bash tool and applies three layers of protection:
 *
 *  1. rm → Recycle Bin: plain `rm <paths>` commands are rewritten to use the
 *     Windows Recycle Bin (PowerShell + Microsoft.VisualBasic), so deletions
 *     are recoverable. Flags (-rf, -f, ...) are passed through and the same
 *     paths are targeted; only the deletion mechanism changes.
 *  2. Dangerous commands → human confirmation via ui.confirm. If the user
 *     declines, the command is blocked.
 *  3. Commands that cannot be safely rewritten (quotes, variables, compound
 *     `cd x && rm y`) fall back to a confirmation prompt as well.
 *
 * Reviewer behavior intentionally has no bash tool; this extension guards
 * the bash tool for behaviors that do (discuss / planner / builder / pruning).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// ── dangerous command patterns (hit → human confirm) ──
interface DangerPattern {
  pattern: RegExp;
  label: string;
}

const DANGEROUS_PATTERNS: DangerPattern[] = [
  { pattern: /git\s+push.*(-f|--force)/, label: "git force push" },
  { pattern: /git\s+reset\s+--hard/, label: "git reset --hard" },
  { pattern: /git\s+clean\s+-[a-z]*f/, label: "git clean -f" },
  { pattern: /git\s+branch\s+-D/, label: "git branch -D" },
  { pattern: /git\s+checkout\s+--\s*\.|git\s+restore\s+\./, label: "discard worktree changes" },
  { pattern: /DROP\s+(TABLE|DATABASE)|TRUNCATE\s+\w+/, label: "destructive SQL" },
  { pattern: /mkfs/, label: "mkfs (format filesystem)" },
  { pattern: /dd\s+if=.*of=\/dev\//, label: "dd to block device" },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b/, label: "system shutdown/reboot" },
  { pattern: /taskkill\s+\/f/, label: "taskkill /f" },
  { pattern: /pip\s+uninstall|conda\s+(remove|env\s+remove)/, label: "package uninstall" },
  { pattern: /chmod\s+(-R\s+)?777\s+\//, label: "chmod 777 /" },
  { pattern: /curl.*\|\s*(sh|bash)\b/, label: "curl piped to shell" },
  { pattern: /\bsudo\s+(rm|dd|mkfs|shutdown|reboot)/, label: "sudo destructive" },
];

// ── rm detection ──
const RM_AT_START = /^\s*rm\b/; // plain `rm ...` at command start
const RM_ANYWHERE = /(^|[;&|]\s*|&&\s*)rm\b/; // rm inside compound command
const RM_ROOT = /rm\s+(-[a-z]*r[a-z]*\s+)?\/(\s|$)/; // rm -rf /
const RM_GLOB_ROOT = /rm\s+(-[a-z]*r[a-z]*\s+)?\/\*/; // rm -rf /*
// rm args that make rewriting unsafe: quoted paths, variables, command subst
const RM_UNSAFE = /['"`$]/;

// PowerShell one-liner: move each path to the Recycle Bin (file or directory).
// Uses the `& { }` block form so $args works on Windows PowerShell 5.1
// (no `--` separator support). Script is wrapped in bash single quotes, so
// PS variables ($args, $p) reach PowerShell untouched.
const PS_RECYCLE_SCRIPT = [
  "& {",
  "  Add-Type -AssemblyName Microsoft.VisualBasic",
  "  foreach ($p in $args) {",
  "    if (Test-Path -LiteralPath $p) {",
  "      if ((Get-Item -LiteralPath $p).PSIsContainer) {",
  '        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, "OnlyErrorDialogs", "SendToRecycleBin")',
  "      } else {",
  '        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, "OnlyErrorDialogs", "SendToRecycleBin")',
  "      }",
  "    }",
  "  }",
  "}",
].join(" ");

function buildRecycleCommand(paths: string[]): string {
  const pathArgs = paths.map((p) => `"$(cygpath -w '${p}')"`).join(" ");
  return `powershell.exe -NoProfile -NonInteractive -Command '${PS_RECYCLE_SCRIPT}' ${pathArgs}`;
}

async function confirmOrBlock(
  ctx: ExtensionContext,
  title: string,
  message: string,
  originalCommand: string,
): Promise<{ block: true; reason: string } | undefined> {
  try {
    const ok = await ctx.ui.confirm(
      title,
      `${message}\n\nCommand:\n${originalCommand}\n\nAllow?`,
    );
    if (ok) return undefined;
    return { block: true, reason: "Blocked by user (bash-guard)" };
  } catch {
    // No interactive UI available → conservative: block dangerous commands.
    return { block: true, reason: `Blocked by bash-guard: ${title} (no UI to confirm)` };
  }
}

export default function bashGuardExtension(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;
    if (!command || !command.trim()) return;

    // ── 1) plain `rm ...` → Recycle Bin ──
    if (RM_AT_START.test(command)) {
      const rest = command.replace(/^\s*rm\b/, "").trim();

      // rm -rf / or rm -rf /* : always require confirmation
      if (RM_ROOT.test(command) || RM_GLOB_ROOT.test(command)) {
        const result = await confirmOrBlock(
          ctx,
          "rm root",
          "This deletes the filesystem root or everything under it.",
          command,
        );
        if (result) return result;
        return;
      }

      // Unsafe to parse (quotes / variables / command substitution) → confirm
      if (RM_UNSAFE.test(rest) || rest.length === 0) {
        const result = await confirmOrBlock(
          ctx,
          "rm (destructive)",
          "Could not safely rewrite this rm command.",
          command,
        );
        if (result) return result;
        return;
      }

      const paths = rest.split(/\s+/).filter((p) => p && !p.startsWith("-"));
      // Flags-only or bare rm: nothing to recycle; keep original semantics.
      if (paths.length === 0) return;

      event.input.command = buildRecycleCommand(paths);
      return;
    }

    // ── 2) rm inside compound commands → confirm (no rewrite) ──
    if (RM_ANYWHERE.test(command)) {
      const result = await confirmOrBlock(
        ctx,
        "rm in compound command",
        "rm is embedded in a compound command; falling back to manual confirmation.",
        command,
      );
      if (result) return result;
      return;
    }

    // ── 3) dangerous patterns → confirm ──
    for (const { pattern, label } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        const result = await confirmOrBlock(ctx, label, "Potentially destructive command.", command);
        if (result) return result;
        break;
      }
    }
  });
}
