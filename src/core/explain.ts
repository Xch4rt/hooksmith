import type { Registry, CommandRule } from "./config.js";
import type { FlagExplanation, Risk } from "./types.js";
import { maxRisk } from "./types.js";
import { tokenize } from "./normalize.js";

export interface Explanation {
  explanation: string;
  flags: FlagExplanation[];
  risk: Risk;
  /** False when the command word was not in the registry (drives LLM fallback). */
  known: boolean;
  /** The resolved command word (basename, sudo unwrapped). */
  command: string;
}

/** Options that consume the following token, per command — so we can find the real subcommand. */
const OPTS_WITH_ARG: Record<string, Set<string>> = {
  git: new Set(["-C", "-c"]),
  docker: new Set(["-H", "--host", "--context", "-c", "--config", "--log-level"]),
};

/** Namespace subcommands to skip so the real verb is found (`docker compose down` → `down`). */
const NAMESPACES: Record<string, Set<string>> = {
  docker: new Set(["compose"]),
};

function basename(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

/** Find the subcommand token (git push, docker up, npm run) skipping global options. */
function findSubcommand(command: string, tokens: string[]): string | undefined {
  const withArg = OPTS_WITH_ARG[command];
  const namespaces = NAMESPACES[command];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("-")) {
      if (withArg?.has(t)) i++; // skip its argument too
      continue;
    }
    if (namespaces?.has(t)) continue; // skip namespace, keep looking for the verb
    return t;
  }
  return undefined;
}

/** Collect and explain notable flags present on the sub-command. */
function explainFlags(rule: CommandRule, tokens: string[]): FlagExplanation[] {
  const flagDefs = rule.flags ?? {};
  const out: FlagExplanation[] = [];
  const seen = new Set<string>();

  const record = (key: string) => {
    const def = flagDefs[key];
    if (def && !seen.has(key)) {
      seen.add(key);
      out.push({ flag: key, explain: def.explain, risk: def.risk });
    }
  };

  for (const raw of tokens) {
    if (!raw.startsWith("-")) continue;
    // --flag=value -> --flag
    const key = raw.includes("=") ? raw.slice(0, raw.indexOf("=")) : raw;
    if (flagDefs[key]) {
      record(key);
      continue;
    }
    // exact long/short match failed; for short bundles like -sS try each letter (-s, -S)
    if (/^-[A-Za-z]{2,}$/.test(key)) {
      for (const ch of key.slice(1)) {
        record(`-${ch}`);
      }
    }
  }
  return out;
}

export function explainOne(normalized: string, registry: Registry): Explanation {
  const tokens = tokenize(normalized);
  if (tokens.length === 0) {
    return { explanation: "(comando vacío)", flags: [], risk: "green", known: true, command: "" };
  }

  // Unwrap sudo: explain the wrapped command, escalate to at least yellow.
  let privileged = false;
  let head = 0;
  if (basename(tokens[0]!) === "sudo") {
    privileged = true;
    head = 1;
    // skip sudo's own options and their args (-u user, -g, etc.)
    while (head < tokens.length && tokens[head]!.startsWith("-")) {
      const opt = tokens[head]!;
      head++;
      if (/^-(u|g|p|C|h|D|R|T)$/.test(opt)) head++; // options that take an argument
    }
  }

  const rest = tokens.slice(head);
  if (rest.length === 0) {
    return {
      explanation: "Ejecuta un comando con privilegios de root (sudo)",
      flags: [],
      risk: "yellow",
      known: true,
      command: "sudo",
    };
  }

  const command = basename(rest[0]!);
  const rule = registry[command];

  if (!rule) {
    const explanation = privileged
      ? `Comando no reconocido, ejecutado con sudo (root): ${command}`
      : `Comando no reconocido: ${command}`;
    return {
      explanation,
      flags: [],
      risk: privileged ? "yellow" : "green",
      known: false,
      command,
    };
  }

  const argTokens = rest.slice(1);
  const parts: string[] = [rule.summary];
  const risks: Risk[] = [rule.risk ?? "green"];

  // subcommand (git push, docker up, npm run, ...)
  if (rule.subcommands) {
    const subToken = findSubcommand(command, argTokens);
    if (subToken) {
      const sub = rule.subcommands[subToken];
      if (sub) {
        parts.push(sub.summary);
        risks.push(sub.risk ?? "green");
      }
    }
  }

  const flags = explainFlags(rule, argTokens);
  for (const f of flags) risks.push(f.risk);

  if (privileged) {
    parts.unshift("Con privilegios de root (sudo)");
    risks.push("yellow");
  }

  return {
    explanation: parts.join(" · "),
    flags,
    risk: maxRisk(risks),
    known: true,
    command,
  };
}
