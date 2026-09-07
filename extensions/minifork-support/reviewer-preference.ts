import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ReviewerRef {
  provider: string;
  modelId: string;
}

export interface MiniforkPreference {
  reviewer?: ReviewerRef;
  behavior?: string;
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

export function loadMiniforkPreference(): MiniforkPreference | null {
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
      `${filePath} is not valid JSON. Run /minifork-model or /minifork-behavior to reset.`,
    );
  }

  if (!isRecord(parsed)) {
    throw new ReviewerPreferenceError(
      `${filePath} has unexpected format. Run /minifork-model or /minifork-behavior to reset.`,
    );
  }

  if (parsed.version !== 1) {
    throw new ReviewerPreferenceError(
      `${filePath} has unsupported version "${String(parsed.version ?? "none")}". Run /minifork-model or /minifork-behavior to reset.`,
    );
  }

  const preference: MiniforkPreference = {};
  if (parsed.reviewer !== undefined) {
    preference.reviewer = parseReviewer(parsed.reviewer, filePath);
  }
  if (parsed.behavior !== undefined) {
    if (
      typeof parsed.behavior !== "string" ||
      parsed.behavior.trim().length === 0
    ) {
      throw new ReviewerPreferenceError(
        `${filePath} has empty or invalid behavior. Run /minifork-behavior to reset.`,
      );
    }
    preference.behavior = parsed.behavior.trim();
  }

  if (!preference.reviewer && !preference.behavior) {
    throw new ReviewerPreferenceError(
      `${filePath} has neither reviewer nor behavior preference. Run /minifork-model or /minifork-behavior to reset.`,
    );
  }

  return preference;
}

export function loadReviewerPreference(): ReviewerRef | null {
  return loadMiniforkPreference()?.reviewer ?? null;
}

export function loadMiniforkBehavior(): string | null {
  return loadMiniforkPreference()?.behavior ?? null;
}

export async function saveReviewerPreference(
  reviewer: ReviewerRef,
): Promise<void> {
  const current = loadMiniforkPreference();
  await writeMiniforkPreference({
    reviewer,
    behavior: current?.behavior,
  });
}

export async function saveMiniforkBehavior(behavior: string): Promise<void> {
  const normalized = behavior.trim();
  if (!normalized) {
    throw new ReviewerPreferenceError("Minifork behavior cannot be empty");
  }
  const current = loadMiniforkPreference();
  await writeMiniforkPreference({
    reviewer: current?.reviewer,
    behavior: normalized,
  });
}

export async function clearReviewerPreference(): Promise<void> {
  const current = loadMiniforkPreference();
  if (!current?.reviewer) return;

  if (current.behavior) {
    await writeMiniforkPreference({ behavior: current.behavior });
    return;
  }
  await removePreferenceFile();
}

export async function clearMiniforkBehavior(): Promise<void> {
  const current = loadMiniforkPreference();
  if (!current?.behavior) return;

  if (current.reviewer) {
    await writeMiniforkPreference({ reviewer: current.reviewer });
    return;
  }
  await removePreferenceFile();
}

async function writeMiniforkPreference(
  preference: MiniforkPreference,
): Promise<void> {
  const filePath = getReviewerPreferencePath();
  const content = `${JSON.stringify(
    {
      version: 1,
      ...(preference.reviewer
        ? {
            reviewer: {
              provider: preference.reviewer.provider,
              modelId: preference.reviewer.modelId,
            },
          }
        : {}),
      ...(preference.behavior ? { behavior: preference.behavior } : {}),
    },
    null,
    2,
  )}\n`;

  const tmpPath = `${filePath}.tmp.${Date.now()}`;
  try {
    await fs.promises.writeFile(tmpPath, content, "utf8");
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    try {
      await fs.promises.unlink(tmpPath);
    } catch (cleanupError) {
      if (!isNodeError(cleanupError) || cleanupError.code !== "ENOENT") {
        throw new ReviewerPreferenceError(
          `Failed to save reviewer preference and clean up temporary file: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
    throw new ReviewerPreferenceError(
      `Failed to save reviewer preference: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function removePreferenceFile(): Promise<void> {
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

function parseReviewer(value: unknown, filePath: string): ReviewerRef {
  if (!isRecord(value)) {
    throw new ReviewerPreferenceError(
      `${filePath} has invalid reviewer field. Run /minifork-model to reset.`,
    );
  }

  const provider = value.provider;
  const modelId = value.modelId;
  if (typeof provider !== "string" || provider.trim().length === 0) {
    throw new ReviewerPreferenceError(
      `${filePath} has empty or missing reviewer.provider. Run /minifork-model to reset.`,
    );
  }
  if (typeof modelId !== "string" || modelId.trim().length === 0) {
    throw new ReviewerPreferenceError(
      `${filePath} has empty or missing reviewer.modelId. Run /minifork-model to reset.`,
    );
  }

  return {
    provider: provider.trim(),
    modelId: modelId.trim(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(err: unknown): err is Error & { code: string } {
  return err instanceof Error && "code" in err;
}
