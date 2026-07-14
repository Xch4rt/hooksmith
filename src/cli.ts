#!/usr/bin/env node
import { explainCommand } from "./core/index.js";
import { loadConfig, loadRegistry } from "./core/config.js";
import { renderClaude } from "./adapters/claude.js";
import { renderCodex } from "./adapters/codex.js";
import {
  extractCommand,
  type Agent,
  type HookInput,
  type HookOutput,
} from "./adapters/types.js";

interface CliArgs {
  agent: Agent;
  configPath?: string;
  command?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let agent: Agent = "claude";
  let configPath: string | undefined;
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") agent = (argv[++i] as Agent) ?? "claude";
    else if (a === "--config") configPath = argv[++i];
    else if (a === "--command") command = argv[++i];
  }
  if (agent !== "claude" && agent !== "codex") agent = "claude";
  return { agent, configPath, command };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function render(agent: Agent, ctx: Parameters<typeof renderClaude>[0]): HookOutput {
  return agent === "codex" ? renderCodex(ctx) : renderClaude(ctx);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Resolve the command from --command (testing) or the stdin hook payload.
  let command = args.command ?? null;
  if (command === null) {
    const raw = await readStdin();
    if (raw.trim()) {
      const input = JSON.parse(raw) as HookInput;
      command = extractCommand(input);
    }
  }

  // Nothing to analyze -> fail open (empty stdout + exit 0 = proceed/allow).
  if (!command || !command.trim()) {
    process.exit(0);
  }

  const config = loadConfig(args.configPath);
  const registry = loadRegistry(config);
  const result = await explainCommand(command, { config, registry });

  const blockingEnabled = process.env.HOOKSMITH_EXPLAIN_ONLY !== "1";
  const output = render(args.agent, { result, blockingEnabled });

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

// A hook must never crash the agent: any failure fails open (empty stdout, exit 0).
main().catch((err) => {
  if (process.env.HOOKSMITH_DEBUG === "1") {
    process.stderr.write(`[hooksmith] error: ${String(err)}\n`);
  }
  process.exit(0);
});
