export type Risk = "green" | "yellow" | "red";

export interface FlagExplanation {
  flag: string;
  explain: string;
  risk: Risk;
}

export interface SubCommand {
  /** Normalized sub-command (env prefixes and redirections stripped). */
  raw: string;
  /** Human-readable explanation of what this sub-command does. */
  explanation: string;
  risk: Risk;
  /** Notable flags found on this sub-command, explained. */
  flags?: FlagExplanation[];
  /** Nesting depth: 0 = top-level, 1+ = inside a $() / backtick subshell. */
  depth: number;
}

export interface ExplainResult {
  subCommands: SubCommand[];
  /** Worst risk across all sub-commands. */
  aggregateRisk: Risk;
  /** Catastrophic patterns detected (drive auto-deny). */
  redFlags: string[];
  /** Fully formatted text, ready to hand to systemMessage. */
  humanSummary: string;
}

/** Ordering helper: higher number = worse. */
export const RISK_ORDER: Record<Risk, number> = { green: 0, yellow: 1, red: 2 };

export function worst(a: Risk, b: Risk): Risk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

export function maxRisk(risks: Risk[]): Risk {
  return risks.reduce<Risk>((acc, r) => worst(acc, r), "green");
}
