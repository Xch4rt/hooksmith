import type { HookOutput, RenderContext, PermissionDecision } from "./types.js";
import { reasonLine } from "./types.js";

/**
 * Codex CLI adapter.
 *
 * Codex asymmetries that shape this policy:
 *  - Only `deny` has effect. `allow` and `ask` are accepted but fail open (no
 *    per-call confirmation UX exists at the hook level), so `ask` effectively
 *    degrades to a non-blocking annotation.
 *  - stdout must never be empty when we want to surface something: empty stdout
 *    + exit 0 = silent allow.
 *
 * Policy: annotate via systemMessage always; the only real "stop and confirm"
 * lever is `deny` on RED. YELLOW/GREEN pass through with the explanation shown.
 */
export function renderCodex(ctx: RenderContext): HookOutput {
  const { result, blockingEnabled } = ctx;
  const hasRed = result.redFlags.length > 0;

  // `allow` here is a fail-open no-op on the decision, but keeps the JSON (and
  // thus systemMessage) present. Only `deny` actually blocks.
  const permissionDecision: PermissionDecision =
    hasRed && blockingEnabled ? "deny" : "allow";

  const reason = hasRed
    ? `${reasonLine(result)} — bloqueado. Revisá la explicación y reintentá o ajustá el permiso.`
    : reasonLine(result);

  return {
    systemMessage: result.humanSummary,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason,
    },
  };
}
