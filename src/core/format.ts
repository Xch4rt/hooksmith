import type { ExplainResult, Risk, SubCommand } from "./types.js";
import type { HooksmithConfig } from "./config.js";

const RISK_LABEL: Record<Risk, string> = {
  green: "🟢 verde",
  yellow: "🟡 amarillo",
  red: "🔴 rojo",
};

const RISK_HEADER: Record<Risk, string> = {
  green: "🟢 Riesgo BAJO",
  yellow: "🟡 Riesgo MEDIO",
  red: "🔴 Riesgo ALTO",
};

function indent(depth: number): string {
  return "  ".repeat(depth);
}

function renderSub(sub: SubCommand, n: number, display: HooksmithConfig["risk_display"]): string {
  const pad = indent(sub.depth);
  const prefix = sub.depth > 0 ? `${pad}└─ subshell:` : `${n}.`;
  const lines = [`${pad}${prefix} ${sub.raw}   [${RISK_LABEL[sub.risk]}]`];
  lines.push(`${pad}   ${sub.explanation}`);
  if (display === "full" && sub.flags && sub.flags.length > 0) {
    lines.push(`${pad}   flags:`);
    for (const f of sub.flags) {
      lines.push(`${pad}     ${f.flag} → ${f.explain}   [${RISK_LABEL[f.risk]}]`);
    }
  }
  return lines.join("\n");
}

export function formatSummary(
  subCommands: SubCommand[],
  aggregateRisk: Risk,
  redFlags: string[],
  config: HooksmithConfig,
): string {
  const out: string[] = [];
  out.push(`${RISK_HEADER[aggregateRisk]} — ${subCommands.length} sub-comando(s)`);
  out.push("");

  let counter = 0;
  for (const sub of subCommands) {
    if (sub.depth === 0) counter++;
    out.push(renderSub(sub, counter, config.risk_display));
  }

  if (redFlags.length > 0) {
    out.push("");
    out.push("🚩 Patrones peligrosos detectados:");
    for (const flag of redFlags) {
      out.push(`   • ${flag}`);
    }
  }

  return out.join("\n");
}

export function buildResult(
  subCommands: SubCommand[],
  aggregateRisk: Risk,
  redFlags: string[],
  config: HooksmithConfig,
): ExplainResult {
  return {
    subCommands,
    aggregateRisk,
    redFlags,
    humanSummary: formatSummary(subCommands, aggregateRisk, redFlags, config),
  };
}
