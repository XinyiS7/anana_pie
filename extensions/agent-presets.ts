import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  SelectList,
  Text,
  type SelectItem,
} from "@earendil-works/pi-tui";
import {
  AgentPresetError,
  formatPresetSummary,
  loadAgentPresetCatalog,
  loadBehaviorFile,
  resolveAgentBehavior,
  resolveAgentPreset,
  type AgentPresetCatalog,
  type BehaviorDefinition,
  type PersonaDefinition,
} from "./agent-presets-support/presets.js";

interface PresetState {
  /** Legacy: preset name persisted by older versions */
  name?: string;
  persona?: string;
  behavior?: string;
}

export default function agentPresetsExtension(pi: ExtensionAPI) {
  let catalog: AgentPresetCatalog = emptyCatalog();
  let activePersona: PersonaDefinition | undefined;
  let activeBehavior: BehaviorDefinition | undefined;
  let initializedSessionKey: string | undefined;

  const refreshCatalog = (ctx: ExtensionContext): void => {
    catalog = loadAgentPresetCatalog(ctx.cwd, ctx.isProjectTrusted());
    for (const error of catalog.errors) {
      ctx.ui.notify(`Agent preset config error: ${error}`, "error");
    }
  };

  const updateStatus = (ctx: ExtensionContext): void => {
    const model = ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : "no-model";
    if (activePersona || activeBehavior) {
      ctx.ui.setStatus(
        "agent",
        ctx.ui.theme.fg(
          "accent",
          `agent:${activePersona?.displayName ?? "none"} · ${activeBehavior?.displayName ?? "none"} · ${model} · thinking:${pi.getThinkingLevel()}`,
        ),
      );
      return;
    }
    ctx.ui.setStatus("agent", undefined);
  };

  const setDisplay = (ctx: ExtensionContext, title: string): void => {
    pi.setSessionName(title);
    ctx.ui.setTitle(title);
    const timer = setTimeout(() => ctx.ui.setTitle(title), 0);
    timer.unref?.();
  };

  const validateTools = (tools: string[] | undefined, label: string): void => {
    if (tools === undefined) return;

    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    const unknown = tools.filter((tool) => !available.has(tool));
    if (unknown.length > 0) {
      throw new AgentPresetError(
        `${label} references unknown tools: ${unknown.join(", ")}`,
      );
    }
  };

  const persistState = (ctx: ExtensionContext): void => {
    const state: PresetState = {
      persona: activePersona?.name,
      behavior: activeBehavior?.name,
    };
    const existing = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "agent-preset-state" &&
          isPresetState(entry.data),
      );
    if (
      existing &&
      isPresetState(existing.data) &&
      existing.data.persona === state.persona &&
      existing.data.behavior === state.behavior
    ) {
      return;
    }
    pi.appendEntry("agent-preset-state", state);
  };

  const applyPreset = async (
    name: string,
    ctx: ExtensionContext,
    options: { persist: boolean },
  ): Promise<void> => {
    const preset = resolveAgentPreset(catalog, name);
    validateTools(preset.tools, `Agent preset "${name}"`);
    validateTools(preset.behavior.tools, `Agent preset "${name}"`);
    validateTools(preset.behavior.excludeTools, `Agent preset "${name}"`);

    if (preset.model) {
      const model = ctx.modelRegistry.find(
        preset.model.provider,
        preset.model.modelId,
      );
      if (!model) {
        throw new AgentPresetError(
          `Agent preset "${name}" model ${preset.model.provider}/${preset.model.modelId} not found`,
        );
      }
      const success = await pi.setModel(model);
      if (!success) {
        throw new AgentPresetError(
          `No authentication for agent preset model ${preset.model.provider}/${preset.model.modelId}`,
        );
      }
    }

    if (preset.thinking) pi.setThinkingLevel(preset.thinking);
    if (preset.tools !== undefined) {
      // 预设级白名单（最高优先）
      pi.setActiveTools(preset.tools);
    } else if (preset.behavior.excludeTools !== undefined) {
      // 行为级黑名单：默认全开，仅排除指定工具
      const excluded = preset.behavior.excludeTools;
      const all = pi.getAllTools().map((t) => t.name);
      pi.setActiveTools(all.filter((t) => !excluded.includes(t)));
    } else if (preset.behavior.tools !== undefined) {
      // 行为级白名单（兼容旧配置）
      pi.setActiveTools(preset.behavior.tools);
    }

    activePersona = preset.persona;
    activeBehavior = preset.behavior;
    setDisplay(ctx, preset.title);
    updateStatus(ctx);
    if (options.persist) persistState(ctx);
  };

  const restoreState = (state: PresetState, ctx: ExtensionContext): void => {
    if (state.name) {
      const preset = resolveAgentPreset(catalog, state.name);
      activePersona = preset.persona;
      activeBehavior = preset.behavior;
      setDisplay(ctx, preset.title);
      updateStatus(ctx);
      return;
    }

    activePersona = state.persona
      ? catalog.personas.get(state.persona)
      : undefined;
    activeBehavior = state.behavior
      ? catalog.behaviors.get(state.behavior)
      : undefined;
    updateStatus(ctx);
  };

  const applyBehavior = (
    name: string,
    ctx: ExtensionContext,
    options: { persist: boolean },
  ): void => {
    const behaviorPath = process.env.PI_AGENT_BEHAVIOR_PATH?.trim();
    const behavior = behaviorPath
      ? loadBehaviorFile(behaviorPath, name)
      : resolveAgentBehavior(catalog, name);
    validateTools(behavior.tools, `Behavior "${name}"`);
    validateTools(behavior.excludeTools, `Behavior "${name}"`);
    if (behavior.excludeTools !== undefined) {
      // 黑名单：默认全开，仅排除指定工具
      const excluded = behavior.excludeTools;
      const all = pi.getAllTools().map((t) => t.name);
      pi.setActiveTools(all.filter((t) => !excluded.includes(t)));
    } else if (behavior.tools !== undefined) {
      pi.setActiveTools(behavior.tools);
    }
    activeBehavior = behavior;
    updateStatus(ctx);
    if (options.persist) persistState(ctx);
  };

  const showSelector = async (
    ctx: ExtensionContext,
    title: string,
    items: SelectItem[],
  ): Promise<string | null> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(`${title} requires interactive mode`, "warning");
      return null;
    }

    if (items.length === 0) {
      ctx.ui.notify(`No ${title.toLowerCase()} found`, "warning");
      return null;
    }

    return ctx.ui.custom<string | null>(
      (tui, theme, _keybindings, done) => {
        const container = new Container();
        container.addChild(
          new DynamicBorder((s: string) => theme.fg("accent", s)),
        );
        container.addChild(
          new Text(theme.fg("accent", theme.bold(title)), 1, 0),
        );

        const selectList = new SelectList(items, Math.min(items.length, 12), {
          selectedPrefix: (s: string) => theme.fg("accent", s),
          selectedText: (s: string) => theme.fg("accent", s),
          description: (s: string) => theme.fg("muted", s),
          scrollInfo: (s: string) => theme.fg("dim", s),
          noMatch: (s: string) => theme.fg("warning", s),
        });
        selectList.onSelect = (item) => done(item.value);
        selectList.onCancel = () => done(null);
        container.addChild(selectList);
        container.addChild(
          new Text(
            theme.fg(
              "dim",
              "type to filter · ↑↓ navigate · enter select · esc cancel",
            ),
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
  };

  const showPresetSelector = async (
    ctx: ExtensionContext,
  ): Promise<string | null> => {
    const items: SelectItem[] = [...catalog.presets.keys()]
      .sort()
      .map((name) => {
        try {
          const preset = resolveAgentPreset(catalog, name);
          return {
            value: name,
            label: name,
            description: formatPresetSummary(preset),
          };
        } catch (error) {
          return {
            value: name,
            label: name,
            description: `invalid: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      });

    return showSelector(ctx, "Select Agent Preset", items);
  };

  const showBehaviorSelector = async (
    ctx: ExtensionContext,
  ): Promise<string | null> => {
    const items: SelectItem[] = [...catalog.behaviors.keys()]
      .sort()
      .map((name) => {
        const behavior = catalog.behaviors.get(name);
        if (!behavior) return null;
        const tools = behavior.tools?.length
          ? ` · tools: ${behavior.tools.join(",")}`
          : "";
        return {
          value: name,
          label: name,
          description: `${behavior.displayName} — ${behavior.description ?? ""}${tools}`,
        };
      })
      .filter((item): item is SelectItem => item !== null);

    return showSelector(ctx, "Select Behavior (keeps persona)", items);
  };

  pi.registerCommand("agent", {
    description: "Switch agent preset",
    handler: async (args, ctx) => {
      refreshCatalog(ctx);
      const requested = args.trim();
      const name = requested || (await showPresetSelector(ctx));
      if (!name) return;

      try {
        await applyPreset(name, ctx, { persist: true });
        ctx.ui.notify(`Agent preset "${name}" activated`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
      }
    },
  });

  pi.registerCommand("behavior", {
    description: "Switch behavior only (keep persona)",
    handler: async (args, ctx) => {
      refreshCatalog(ctx);
      const requested = args.trim();
      const name = requested || (await showBehaviorSelector(ctx));
      if (!name) return;

      try {
        applyBehavior(name, ctx, { persist: true });
        ctx.ui.notify(`Behavior "${name}" activated`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
      }
    },
  });

  pi.on("before_agent_start", async (event) => {
    const sections: string[] = [];
    if (activePersona) sections.push(activePersona.body);
    if (activeBehavior) sections.push(activeBehavior.body);
    if (sections.length === 0) return;

    return {
      systemPrompt: `${sections.join("\n\n---\n\n")}\n\n---\n\n${event.systemPrompt}`,
    };
  });

  pi.on("model_select", (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("thinking_level_select", (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    const sessionKey = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
    if (initializedSessionKey === sessionKey) return;
    initializedSessionKey = sessionKey;

    refreshCatalog(ctx);
    activePersona = undefined;
    activeBehavior = undefined;

    const behaviorName = process.env.PI_AGENT_BEHAVIOR?.trim();
    if (behaviorName) {
      try {
        applyBehavior(behaviorName, ctx, { persist: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
      }
      return;
    }

    const envPreset = process.env.PI_AGENT_PRESET?.trim();
    if (envPreset) {
      try {
        await applyPreset(envPreset, ctx, { persist: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
      }
      return;
    }

    const state = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "agent-preset-state" &&
          isPresetState(entry.data),
      );
    if (state && isPresetState(state.data)) {
      try {
        restoreState(state.data, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
      }
      return;
    }

    updateStatus(ctx);
  });
}

function isPresetState(value: unknown): value is PresetState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    (typeof v.name === "string" && v.name.length > 0) ||
    (typeof v.behavior === "string" && v.behavior.length > 0)
  );
}

function emptyCatalog(): AgentPresetCatalog {
  return {
    personas: new Map(),
    behaviors: new Map(),
    presets: new Map(),
    errors: [],
    projectDir: null,
  };
}
