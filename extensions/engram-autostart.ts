/**
 * Engram Auto-Start Extension — keep the engram HTTP server alive for pi.
 *
 * pi has no built-in MCP, so `engram-memory.ts` talks to the engram HTTP API
 * on 127.0.0.1:7437 directly (mem_recall/mem_stats/mem_context) plus the
 * `engram.exe` CLI (mem_save). This extension makes sure that HTTP server is
 * actually running: on every `session_start` it probes the port and spawns
 * `engram.exe serve` (detached, stdio-ignored) if the port is not reachable.
 *
 * The spawned process is detached and unref'd, so it survives pi's lifetime —
 * the server keeps running across sessions, and pi exit does not take it down.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENGRAM_PORT = 7437;
const ENGRAM_BASE = `http://127.0.0.1:${ENGRAM_PORT}`;
const PROBE_TIMEOUT_MS = 800;
const BOOT_WAIT_MS = 6000;

/** Resolve engram.exe: env override → known install path → PATH. */
function resolveExe(): string {
  if (process.env.ENGRAM_EXE) return process.env.ENGRAM_EXE;
  const known = join(
    process.env.LOCALAPPDATA ?? "",
    "gentle-ai",
    "bin",
    "engram.exe"
  );
  if (known && existsSync(known)) return known;
  return "engram.exe";
}

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(`${ENGRAM_BASE}/stats`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function spawnServer(): void {
  const child = spawn(resolveExe(), ["serve"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Already up — leave the status line to engram-memory.ts.
    if (await isUp()) return;

    try {
      spawnServer();
    } catch (err) {
      ctx.ui.setStatus("engram", `auto-start failed: ${(err as Error).message}`);
      return;
    }

    // Poll until the API answers or we give up.
    const deadline = Date.now() + BOOT_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      if (await isUp()) {
        ctx.ui.setStatus("engram", "engram server started (auto)");
        return;
      }
    }
    ctx.ui.setStatus("engram", "engram auto-start: server not responding yet");
  });
}
