import type { ExplainResult } from "../core/types.js";

export type Agent = "claude" | "codex";

export type PermissionDecision = "allow" | "deny" | "ask";

/** Shared hook wire input — both agents converged on this shape. */
export interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: string };
  // Codex-only extras (ignored by the core): model, turn_id, ...
  [key: string]: unknown;
}

/** Shared hook wire output. Both agents parse this JSON only on exit 0. */
export interface HookOutput {
  systemMessage: string;
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: PermissionDecision;
    permissionDecisionReason: string;
  };
}

export interface RenderContext {
  result: ExplainResult;
  /** True unless HOOKSMITH_EXPLAIN_ONLY disables blocking. */
  blockingEnabled: boolean;
}

export function extractCommand(input: HookInput): string | null {
  const cmd = input.tool_input?.command;
  return typeof cmd === "string" ? cmd : null;
}

/** Short reason line for logs/verbose, derived from the result. */
export function reasonLine(result: ExplainResult): string {
  const risk = result.aggregateRisk.toUpperCase();
  if (result.redFlags.length > 0) {
    return `Riesgo ${risk}. Patrones peligrosos: ${result.redFlags.join("; ")}`;
  }
  return `Riesgo ${risk}. ${result.subCommands.length} sub-comando(s) analizados.`;
}
