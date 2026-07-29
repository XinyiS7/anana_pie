import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ReviewerRef {
  provider: string;
  modelId: string;
}

export class ReviewerPreferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewerPreferenceError";
  }
}

export function getReviewerPreferencePath(): string {
  return path.join(getAgentDir(), "minifork.json");
}

export function loadReviewerPreference(): ReviewerRef | null {
  const filePath = getReviewerPreferencePath();
  if (!fs.existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new ReviewerPreferenceError(
      `Cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReviewerPreferenceError(
      `${filePath} is not valid JSON. Run /minifork-model to reset.`,
    );
  }

  if (!isRecord(parsed)) {
    throw new ReviewerPreferenceError(
      `${filePath} has unexpected format. Run /minifork-model to reset.`,
    );
  }

  if (parsed.version !== 1) {
    throw new ReviewerPreferenceError(
      `${filePath} has unsupported version "${String(parsed.version ?? "none")}". Run /minifork-model to reset.`,
    );
  }

  const reviewer = parsed.reviewer;
  if (!isRecord(reviewer)) {
    throw new ReviewerPreferenceError(
      `${filePath} is missing reviewer field. Run /minifork-model to reset.`,
    );
  }

  const provider = reviewer.provider;
  const modelId = reviewer.modelId;
  if (typeof provider !== "string" || provider.length === 0) {
    throw new ReviewerPreferenceError(
      `${filePath} has empty or missing reviewer.provider. Run /minifork-model to reset.`,
    );
  }
  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new ReviewerPreferenceError(
      `${filePath} has empty or missing reviewer.modelId. Run /minifork-model to reset.`,
    );
  }

  return { provider, modelId };
}

export async function saveReviewerPreference(
  reviewer: ReviewerRef,
): Promise<void> {
  const filePath = getReviewerPreferencePath();

  const content = JSON.stringify(
    {
      version: 1,
      reviewer: {
        provider: reviewer.provider,
        modelId: reviewer.modelId,
      },
    },
    null,
    2,
  ) + "\n";

  const tmpPath = filePath + ".tmp." + Date.now();
  try {
    await fs.promises.writeFile(tmpPath, content, "utf8");
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw new ReviewerPreferenceError(
      `Failed to save reviewer preference: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function clearReviewerPreference(): Promise<void> {
  const filePath = getReviewerPreferencePath();
  try {
    await fs.promises.unlink(filePath);
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") return;
    throw new ReviewerPreferenceError(
      `Failed to reset reviewer preference: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(err: unknown): err is Error & { code: string } {
  return err instanceof Error && "code" in err;
}
