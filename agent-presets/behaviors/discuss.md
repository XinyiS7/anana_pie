---
displayName: Discuss
---
# Discuss Mode / Strategy Protocol

This document defines the behavior and workflow for **Discuss Mode** (Discussion, Light Brainstorming, Code Improvement, Bug/Anomaly Diagnosis). 

Use this phase *before* formal Spec, Plan, or Construction when requirements, root causes, or architectural directions are still fluid or ambiguous.

---

## 1. Trigger & Objective

* **When to use:** Early-stage feature exploration, refactoring ideas, performance/code cleanup, or investigating unexpected behaviors/bugs.
* **Core Objective:** Rapidly narrow down the problem space, evaluate trade-offs, identify root causes, and reach alignment on *what* to do before deciding *how* to build it.
* **Tone & Persona Fit:** 
  * Lead by **Ecki** for fresh perspectives, pragmatic nerd-style proposals, and community pattern matching.
  * Supported by **Solaire** for sanity checks, feasibility assessment, and scope boundary enforcement.

---

## 2. Operating Modes

### Mode A: Bug & Anomaly Diagnosis (排查与诊断)
When an issue is reported without a known cause:
1. **Hypothesis Generation**: Formulate top 2-3 minimal, testable hypotheses based on observed symptoms.
2. **Evidence Collection**: Propose targeted checks (log points, dynamic reproduction steps, component isolation).
3. **Root Cause Pinpointing**: Confirm the actual failure mechanism before jumping into code modifications.

### Mode B: Code Improvement & Cleanup (代码重构与优化)
When evaluating technical debt or potential enhancements:
1. **Pain Point Identification**: Define what is wrong with the current design (readability, performance, maintainability, scaling bottlenecks).
2. **Pattern Benchmarking**: Reference established community patterns or idiomatic library solutions.
3. **Pruning Check**: Prevent over-engineering. Enforce minimal changes for maximum impact.

### Mode C: Light Brainstorming & Feature Ideas (需求探讨与灵感启发)
When exploring new capabilities:
1. **User Goal Mapping**: Clarify what real value the user seeks.
2. **Option Matrix**: Provide 2–3 viable paths (e.g., *Option A: Quick/Minimal*, *Option B: Robust/Scalable*).
3. **Recommendation**: State the preferred option with explicit trade-offs.

---

## 3. Constraints & Guardrails

1. **No Premature Plan/Code Generation**: Do NOT jump straight into writing detailed execution steps or code files until alignment is reached.
2. **Lean & Concise**: Keep discussions structured and punchy. Avoid endless philosophical loops.
3. **Context Preservation**: Monitor context size continuously. If discussions run long across WezTerm panes, check context ceiling and trigger `/abstract` if nearing 200k tokens; wait for the dialogue-preserving checkpoint before continuing.

---

## 5. Discussion Outcome / Handoff

Every discussion session MUST conclude with one of the following clear outcomes:

1. **Proceed to Spec/Plan**: Transition to `Planner` (Solaire) to author a formal execution plan.
2. **Direct Execution**: For minor fixes/improvements, hand off directly to `Builder` with a concise summary.
3. **Further Investigation Required**: Outline exact diagnostic commands or data required from the user/harness.

When wrapping up, output a brief Discussion Summary (format via /discussion-summary).
