import type { HookOutput, RenderContext, PermissionDecision } from "./types.js";
import { reasonLine } from "./types.js";

/**
 * Claude Code adapter.
 *
 * Policy: explain without blocking. Force `ask` so the approval prompt is
 * annotated with the explanation; reserve `deny` for RED red-flag commands
 * (unless blocking is disabled via HOOKSMITH_EXPLAIN_ONLY).
 *
 * `ask` is genuinely interactive in Claude Code, so the user reads the summary
 * and approves/rejects per call. A hook `allow` cannot loosen a settings-level
 * `deny`; hooks only harden.
 */
export function renderClaude(ctx: RenderContext): HookOutput {
  const { result, blockingEnabled } = ctx;
  const hasRed = result.redFlags.length > 0;

  const permissionDecision: PermissionDecision =
    hasRed && blockingEnabled ? "deny" : "ask";

  return {
    systemMessage: result.humanSummary,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reasonLine(result),
    },
  };
}
