import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { Risk } from "./types.js";

export interface CommandRule {
  summary: string;
  /** Default risk for the bare command (before flags/patterns escalate it). */
  risk?: Risk;
  flags?: Record<string, { explain: string; risk: Risk }>;
  /** Second-word subcommands: git push, docker up, npm run, ... */
  subcommands?: Record<string, { summary: string; risk?: Risk }>;
}

export type Registry = Record<string, CommandRule>;

export interface LlmFallbackConfig {
  enabled: boolean;
  model: string;
  timeout_ms: number;
}

export interface HooksmithConfig {
  registry_path: string;
  llm_fallback: LlmFallbackConfig;
  /** Regex strings (matched against the raw command) that force RED / auto-deny. */
  auto_deny_patterns: { pattern: string; reason: string }[];
  /** How verbose the humanSummary is. */
  risk_display: "compact" | "full";
}

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/core -> ../../config ; src/core -> ../../config. Both resolve to <root>/config.
const DEFAULT_CONFIG_DIR = resolve(HERE, "..", "..", "config");

const DEFAULTS: HooksmithConfig = {
  registry_path: join(DEFAULT_CONFIG_DIR, "registry.json"),
  llm_fallback: { enabled: false, model: "claude-haiku-4-5-20251001", timeout_ms: 4000 },
  auto_deny_patterns: [],
  risk_display: "full",
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * Load config, resolving the path from (in priority order):
 * explicit arg -> $HOOKSMITH_CONFIG -> bundled config/hooksmith.config.json.
 * Any read/parse failure degrades to built-in defaults (a hook must never crash).
 */
export function loadConfig(explicitPath?: string): HooksmithConfig {
  const path =
    explicitPath ||
    process.env.HOOKSMITH_CONFIG ||
    join(DEFAULT_CONFIG_DIR, "hooksmith.config.json");
  let cfg: HooksmithConfig = { ...DEFAULTS };
  try {
    const loaded = readJson<Partial<HooksmithConfig>>(path);
    cfg = {
      ...DEFAULTS,
      ...loaded,
      llm_fallback: { ...DEFAULTS.llm_fallback, ...(loaded.llm_fallback ?? {}) },
    };
    // Resolve a relative registry_path against the config file's directory.
    if (loaded.registry_path && !loaded.registry_path.startsWith("/")) {
      cfg.registry_path = resolve(dirname(path), loaded.registry_path);
    }
  } catch {
    // keep defaults
  }
  return cfg;
}

export function loadRegistry(cfg: HooksmithConfig): Registry {
  try {
    return readJson<Registry>(cfg.registry_path);
  } catch {
    return {};
  }
}
