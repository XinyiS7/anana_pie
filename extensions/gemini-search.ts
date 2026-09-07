/**
 * gemini-search — ExoCore 同款 Gemini grounding 搜索包装成 pi 的默认 web_search。
 *
 * 原理：Gemini 官方 API 的 googleSearch 工具（模型侧 grounding），
 * 与 ExoCore engines/llm.py `grounding=True → types.GoogleSearch()` 同一套。
 *
 * Key 来源（按优先级）：
 *   1. ~/.pi/web-search.json 的 "geminiApiKey"（与 pi-web-access 兼容格式）
 *   2. 环境变量 GEMINI_API_KEY（ExoCore .env 同款）
 *
 * 用法：pi 里直接让 agent 调 web_search({ query, numResults? })。
 *
 * 模型可用 web-search.json 的 geminiModel 覆盖（默认 gemini-3.5-flash-lite）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const MODEL_DEFAULT = "gemini-3.5-flash-lite";
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiChunk {
  web?: { uri?: string; title?: string };
}

interface SearchConfig {
  apiKey: string;
  model: string;
}

function resolveConfig(): SearchConfig {
  let apiKey = "";
  let model = MODEL_DEFAULT;

  // 1) ~/.pi/web-search.json → geminiApiKey / geminiModel
  const cfgPath = join(homedir(), ".pi", "web-search.json");
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (cfg.geminiApiKey) apiKey = cfg.geminiApiKey;
      if (typeof cfg.geminiModel === "string" && cfg.geminiModel) {
        model = cfg.geminiModel;
      }
    } catch {
      /* 配置损坏则静默回退到 env */
    }
  }

  // 2) 环境变量（ExoCore 同款）
  if (!apiKey && process.env.GEMINI_API_KEY) {
    apiKey = process.env.GEMINI_API_KEY;
  }
  if (!apiKey) {
    throw new Error(
      "未找到 Gemini key：请在 ~/.pi/web-search.json 配 geminiApiKey，或设置环境变量 GEMINI_API_KEY",
    );
  }
  return { apiKey, model };
}

async function search(query: string, numResults: number): Promise<string> {
  const { apiKey, model } = resolveConfig();
  const url = `${BASE_URL}/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: query }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini API ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: {
        webSearchQueries?: string[];
        groundingChunks?: GeminiChunk[];
      };
    }>;
  };

  const candidate = data.candidates?.[0];
  const answer =
    candidate?.content?.parts?.map((p) => p.text ?? "").join("\n") ?? "";
  // groundingMetadata 位于 candidate 上（不在顶层）
  const chunks = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((c) => c.web)
    .filter((w): w is { uri: string; title?: string } => Boolean(w?.uri))
    .slice(0, numResults);

  const lines = [
    answer.trim() || "（Gemini 未返回摘要文本）",
    "",
    "来源（由 Google Search grounding 提供）：",
  ];
  chunks.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.title ?? c.uri} — ${c.uri}`);
  });

  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search (Gemini grounding)",
    description:
      "通过 Gemini 官方 Google Search grounding 搜索网页，返回带引用的合成摘要。" +
      "支持普通查询、批量相关性搜索、事实核查等。结果含来源链接列表。",
    parameters: Type.Object({
      query: Type.String({ description: "搜索查询，如 \"TypeScript best practices 2025\"" }),
      numResults: Type.Optional(
        Type.Number({ description: "来源引用条数（默认 5，最大 10）", default: 5 }),
      ),
    }),
    async execute(toolCallId, params) {
      const n = Math.max(1, Math.min(10, params.numResults ?? 5));
      try {
        const text = await search(params.query, n);
        return { content: [{ type: "text", text }], details: { query: params.query } };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `web_search 失败：${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: { error: true },
          isError: true,
        };
      }
    },
  });
}