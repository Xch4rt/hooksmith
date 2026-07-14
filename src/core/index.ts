import { decompose } from "./decompose.js";
import { normalize } from "./normalize.js";
import { explainOne } from "./explain.js";
import { classify } from "./classify.js";
import { buildResult } from "./format.js";
import { llmExplain } from "./llm.js";
import { loadConfig, loadRegistry, type HooksmithConfig, type Registry } from "./config.js";
import type { ExplainResult, SubCommand } from "./types.js";

export * from "./types.js";
export * from "./config.js";

export interface ExplainOptions {
  config?: HooksmithConfig;
  registry?: Registry;
}

/**
 * The agnostic core pipeline:
 *   decompose → normalize → explain (registry, optional LLM fallback) → classify → format
 * Returns a neutral ExplainResult; knows nothing about any agent or wire format.
 */
export async function explainCommand(
  command: string,
  opts: ExplainOptions = {},
): Promise<ExplainResult> {
  const config = opts.config ?? loadConfig();
  const registry = opts.registry ?? loadRegistry(config);

  const decomposed = decompose(command);

  const subCommands: SubCommand[] = await Promise.all(
    decomposed.map(async ({ raw, depth }): Promise<SubCommand> => {
      const normalized = normalize(raw);
      const ex = explainOne(normalized, registry);

      if (!ex.known && config.llm_fallback.enabled) {
        const llm = await llmExplain(normalized, config.llm_fallback);
        if (llm) {
          return {
            raw: normalized || raw,
            explanation: llm.explanation,
            risk: llm.risk,
            depth,
          };
        }
      }

      return {
        raw: normalized || raw,
        explanation: ex.explanation,
        risk: ex.risk,
        flags: ex.flags.length > 0 ? ex.flags : undefined,
        depth,
      };
    }),
  );

  const { redFlags, aggregateRisk } = classify(
    command,
    subCommands.map((s) => ({ raw: s.raw, risk: s.risk })),
    config,
  );

  return buildResult(subCommands, aggregateRisk, redFlags, config);
}
