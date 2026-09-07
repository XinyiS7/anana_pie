import * as fs from "node:fs";
import * as path from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AgentThinkingLevel = (typeof THINKING_LEVELS)[number];
export type DefinitionSource = "global" | "project";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface PersonaDefinition {
  name: string;
  displayName: string;
  body: string;
  source: DefinitionSource;
  filePath: string;
}

export interface BehaviorDefinition {
  name: string;
  displayName: string;
  description?: string;
  tools?: string[];
  /** 黑名单：从全部已注册工具中排除（与 tools 白名单互斥，优先） */
  excludeTools?: string[];
  body: string;
  source: DefinitionSource;
  filePath: string;
}

interface AgentPresetDefinition {
  name: string;
  personaName?: string;
  behaviorName: string;
  model?: ModelRef;
  thinking?: AgentThinkingLevel;
  tools?: string[];
  title: string;
  source: DefinitionSource;
  filePath: string;
}

export interface AgentPreset extends AgentPresetDefinition {
  persona?: PersonaDefinition;
  behavior: BehaviorDefinition;
}

export interface AgentPresetCatalog {
  personas: Map<string, PersonaDefinition>;
  behaviors: Map<string, BehaviorDefinition>;
  presets: Map<string, AgentPresetDefinition>;
  errors: string[];
  projectDir: string | null;
}

export class AgentPresetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentPresetError";
  }
}

interface NamespaceLoad<T> {
  values: Map<string, T>;
  invalidNames: Set<string>;
}

const STEM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function loadAgentPresetCatalog(
  cwd: string,
  includeProject: boolean,
): AgentPresetCatalog {
  const errors: string[] = [];
  const globalDir = path.join(getAgentDir(), "agent-presets");
  const projectDir = includeProject ? findProjectPresetsDir(cwd) : null;

  const globalPersonas = loadPersonas(
    path.join(globalDir, "personas"),
    "global",
    errors,
  );
  const globalBehaviors = loadBehaviors(
    path.join(globalDir, "behaviors"),
    "global",
    errors,
  );
  const globalPresets = loadPresets(
    path.join(globalDir, "presets"),
    "global",
    errors,
  );

  const personas = mergeNamespace(globalPersonas, {
    values: new Map(),
    invalidNames: new Set(),
  });
  const behaviors = mergeNamespace(globalBehaviors, {
    values: new Map(),
    invalidNames: new Set(),
  });
  const presets = mergeNamespace(globalPresets, {
    values: new Map(),
    invalidNames: new Set(),
  });

  if (projectDir) {
    mergeIntoNamespace(
      personas,
      loadPersonas(path.join(projectDir, "personas"), "project", errors),
    );
    mergeIntoNamespace(
      behaviors,
      loadBehaviors(path.join(projectDir, "behaviors"), "project", errors),
    );
    mergeIntoNamespace(
      presets,
      loadPresets(path.join(projectDir, "presets"), "project", errors),
    );
  }

  return {
    personas,
    behaviors,
    presets,
    errors,
    projectDir,
  };
}

export function resolveAgentPreset(
  catalog: AgentPresetCatalog,
  name: string,
): AgentPreset {
  const preset = catalog.presets.get(name);
  if (!preset) {
    throw new AgentPresetError(
      `Unknown agent preset "${name}". Available: ${formatNames(catalog.presets.keys())}`,
    );
  }

  const behavior = catalog.behaviors.get(preset.behaviorName);
  if (!behavior) {
    throw new AgentPresetError(
      `Agent preset "${name}" requires missing behavior "${preset.behaviorName}"`,
    );
  }

  let persona: PersonaDefinition | undefined;
  if (preset.personaName) {
    persona = catalog.personas.get(preset.personaName);
    if (!persona) {
      throw new AgentPresetError(
        `Agent preset "${name}" references missing persona "${preset.personaName}"`,
      );
    }
  }

  return {
    ...preset,
    persona,
    behavior,
  };
}

export function resolveAgentBehavior(
  catalog: AgentPresetCatalog,
  name: string,
): BehaviorDefinition {
  const behavior = catalog.behaviors.get(name);
  if (!behavior) {
    throw new AgentPresetError(
      `Unknown agent behavior "${name}". Available: ${formatNames(catalog.behaviors.keys())}`,
    );
  }
  return behavior;
}

export function loadBehaviorFile(
  filePath: string,
  expectedName?: string,
): BehaviorDefinition {
  const name = path.basename(filePath, path.extname(filePath));
  if (expectedName && name !== expectedName) {
    throw new AgentPresetError(
      `Behavior file "${filePath}" does not match expected key "${expectedName}"`,
    );
  }

  const document = readFrontmatter(filePath);
  const body = requireBody(document.body, filePath, "behavior");
  const displayName = optionalString(
    document.frontmatter.displayName,
    "displayName",
    filePath,
  ) ?? name;
  const description = optionalString(
    document.frontmatter.description,
    "description",
    filePath,
  );

  return {
    name,
    displayName,
    description,
    tools: parseTools(document.frontmatter.tools, filePath),
    excludeTools: parseTools(
      document.frontmatter.exclude_tools,
      filePath,
      "exclude_tools",
    ),
    body,
    source: "global",
    filePath,
  };
}

export function parseModelRef(value: string, source: string): ModelRef {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new AgentPresetError(
      `${source} model must use provider/model format, got "${value}"`,
    );
  }
  return {
    provider: value.slice(0, separator),
    modelId: value.slice(separator + 1),
  };
}

export function formatPresetSummary(preset: AgentPreset): string {
  const parts = [
    `persona:${preset.persona?.displayName ?? "none"}`,
    `behavior:${preset.behavior.displayName}`,
  ];
  if (preset.model) {
    parts.push(`model:${preset.model.provider}/${preset.model.modelId}`);
  }
  if (preset.thinking) parts.push(`thinking:${preset.thinking}`);
  parts.push(`title:${preset.title}`);
  return parts.join(" · ");
}

export function formatNames(names: Iterable<string>): string {
  const values = [...names].sort();
  return values.length > 0 ? values.join(", ") : "(none)";
}

function loadPersonas(
  dir: string,
  source: DefinitionSource,
  errors: string[],
): NamespaceLoad<PersonaDefinition> {
  return loadNamespace(dir, source, errors, (name, filePath) => {
    const document = readFrontmatter(filePath);
    return {
      name,
      displayName:
        optionalString(
          document.frontmatter.displayName,
          "displayName",
          filePath,
        ) ?? name,
      body: requireBody(document.body, filePath, "persona"),
      source,
      filePath,
    };
  });
}

function loadBehaviors(
  dir: string,
  source: DefinitionSource,
  errors: string[],
): NamespaceLoad<BehaviorDefinition> {
  return loadNamespace(dir, source, errors, (name, filePath) => {
    const document = readFrontmatter(filePath);
    return {
      name,
      displayName:
        optionalString(
          document.frontmatter.displayName,
          "displayName",
          filePath,
        ) ?? name,
      description: optionalString(
        document.frontmatter.description,
        "description",
        filePath,
      ),
      tools: parseTools(document.frontmatter.tools, filePath),
      excludeTools: parseTools(
        document.frontmatter.exclude_tools,
        filePath,
        "exclude_tools",
      ),
      body: requireBody(document.body, filePath, "behavior"),
      source,
      filePath,
    };
  });
}

function loadPresets(
  dir: string,
  source: DefinitionSource,
  errors: string[],
): NamespaceLoad<AgentPresetDefinition> {
  return loadNamespace(dir, source, errors, (name, filePath) => {
    const document = readFrontmatter(filePath);
    if (document.body.trim()) {
      throw new AgentPresetError(
        `Preset file "${filePath}" must not contain a body; put instructions in persona/behavior files`,
      );
    }

    const behaviorName = requiredString(
      document.frontmatter.behavior,
      "behavior",
      filePath,
    );
    const personaName = optionalString(
      document.frontmatter.persona,
      "persona",
      filePath,
    );
    const modelValue = optionalString(
      document.frontmatter.model,
      "model",
      filePath,
    );
    const thinkingValue = optionalString(
      document.frontmatter.thinking,
      "thinking",
      filePath,
    );
    const title = requiredString(
      document.frontmatter.title,
      "title",
      filePath,
    );

    let model: ModelRef | undefined;
    if (modelValue) model = parseModelRef(modelValue, filePath);

    let thinking: AgentThinkingLevel | undefined;
    if (thinkingValue) {
      if (!THINKING_LEVELS.includes(thinkingValue as AgentThinkingLevel)) {
        throw new AgentPresetError(
          `${filePath} thinking must be one of ${THINKING_LEVELS.join(", ")}`,
        );
      }
      thinking = thinkingValue as AgentThinkingLevel;
    }

    const tools = parseTools(document.frontmatter.tools, filePath);

    return {
      name,
      personaName,
      behaviorName,
      model,
      thinking,
      tools,
      title,
      source,
      filePath,
    };
  });
}

function loadNamespace<T>(
  dir: string,
  source: DefinitionSource,
  errors: string[],
  parse: (name: string, filePath: string) => T,
): NamespaceLoad<T> {
  const values = new Map<string, T>();
  const invalidNames = new Set<string>();

  if (!fs.existsSync(dir)) return { values, invalidNames };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    errors.push(
      `Cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { values, invalidNames };
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    const name = entry.name.slice(0, -3);
    if (!STEM_PATTERN.test(name)) {
      invalidNames.add(name);
      errors.push(
        `${filePath} has invalid file stem "${name}"; use letters, numbers, dot, dash, or underscore`,
      );
      continue;
    }

    try {
      values.set(name, parse(name, filePath));
    } catch (error) {
      invalidNames.add(name);
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { values, invalidNames };
}

function mergeNamespace<T>(
  base: NamespaceLoad<T>,
  overlay: NamespaceLoad<T>,
): Map<string, T> {
  const values = new Map(base.values);
  for (const name of base.invalidNames) values.delete(name);
  mergeIntoNamespace(values, overlay);
  return values;
}

function mergeIntoNamespace<T>(
  target: Map<string, T>,
  overlay: NamespaceLoad<T>,
): void {
  for (const name of overlay.invalidNames) target.delete(name);
  for (const [name, value] of overlay.values) target.set(name, value);
}

function findProjectPresetsDir(cwd: string): string | null {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, CONFIG_DIR_NAME, "agent-presets");
    if (isDirectory(candidate)) return candidate;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function readFrontmatter(filePath: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new AgentPresetError(
      `Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    return parseFrontmatter<Record<string, unknown>>(content);
  } catch (error) {
    throw new AgentPresetError(
      `${filePath} has invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requiredString(
  value: unknown,
  field: string,
  filePath: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentPresetError(
      `${filePath} requires non-empty string field "${field}"`,
    );
  }
  return value.trim();
}

function optionalString(
  value: unknown,
  field: string,
  filePath: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field, filePath);
}

function requireBody(body: string, filePath: string, kind: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    throw new AgentPresetError(
      `${filePath} requires a non-empty ${kind} body`,
    );
  }
  return trimmed;
}

function parseTools(
  value: unknown,
  filePath: string,
  fieldName = "tools",
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new AgentPresetError(
      `${filePath} field "${fieldName}" must be a YAML string array`,
    );
  }

  const tools: string[] = [];
  for (const tool of value) {
    if (typeof tool !== "string" || tool.trim().length === 0) {
      throw new AgentPresetError(
        `${filePath} field "${fieldName}" must contain only non-empty strings`,
      );
    }
    tools.push(tool.trim());
  }
  return [...new Set(tools)];
}
