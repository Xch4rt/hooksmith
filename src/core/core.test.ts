import { test } from "node:test";
import assert from "node:assert/strict";
import { decompose, splitByOperators, findSubstitutions } from "./decompose.js";
import { normalize, stripEnvPrefixes, stripRedirections } from "./normalize.js";
import { explainCommand } from "./index.js";
import { loadConfig, loadRegistry } from "./config.js";

const config = loadConfig();
const registry = loadRegistry(config);
const run = (cmd: string) => explainCommand(cmd, { config, registry });

test("registry seed loads", () => {
  assert.ok(registry.curl, "curl rule present");
  assert.ok(Object.keys(registry).length > 20);
});

test("splitByOperators: composed && | ; respecting quotes", () => {
  assert.deepEqual(splitByOperators("git status && rm -rf build"), [
    "git status",
    "rm -rf build",
  ]);
  assert.deepEqual(splitByOperators("a | b | c"), ["a", "b", "c"]);
  assert.deepEqual(splitByOperators("a || b ; c"), ["a", "b", "c"]);
  // operator chars inside single quotes must not split
  assert.deepEqual(splitByOperators("echo 'a && b'"), ["echo 'a && b'"]);
  // `&` inside a redirection must not split
  assert.deepEqual(splitByOperators("ls > x 2>&1"), ["ls > x 2>&1"]);
});

test("findSubstitutions: $() and backticks, skips single quotes", () => {
  assert.deepEqual(findSubstitutions("echo $(rm -rf /)"), ["rm -rf /"]);
  assert.deepEqual(findSubstitutions("echo `date`"), ["date"]);
  assert.deepEqual(findSubstitutions("echo '$(not a sub)'"), []);
  // balanced nested parens
  assert.deepEqual(findSubstitutions("echo $(foo $(bar))"), ["foo $(bar)"]);
});

test("decompose: recurses into nested subshells with depth", () => {
  const d = decompose("echo $(rm -rf /)");
  assert.deepEqual(d, [
    { raw: "echo $(rm -rf /)", depth: 0 },
    { raw: "rm -rf /", depth: 1 },
  ]);
});

test("normalize: strips env prefixes and redirections", () => {
  assert.equal(stripEnvPrefixes("EDITOR=vim git commit"), "git commit");
  assert.equal(stripEnvPrefixes("A=1 B=2 make"), "make");
  assert.equal(stripRedirections("ls > out.txt 2>&1"), "ls");
  assert.equal(stripRedirections("cat < in.txt"), "cat");
  assert.equal(normalize("FOO=bar ls -la > /dev/null"), "ls -la");
});

test("explain: curl --resolve real-world case is yellow with flag explanations", async () => {
  const r = await run(
    'curl --resolve api.example.com:443:1.2.3.4 -o /dev/null -sS -w "%{http_code}" https://api.example.com',
  );
  assert.equal(r.aggregateRisk, "yellow");
  assert.equal(r.redFlags.length, 0);
  const flags = r.subCommands[0]?.flags?.map((f) => f.flag) ?? [];
  assert.ok(flags.includes("--resolve"));
  assert.ok(flags.includes("-s"));
  assert.ok(flags.includes("-S"));
  assert.ok(flags.includes("-w"));
});

test("classify: rm -rf / is RED with red flags", async () => {
  const r = await run("rm -rf /");
  assert.equal(r.aggregateRisk, "red");
  assert.ok(r.redFlags.length >= 1);
});

test("classify: curl | sh is RED (pipe to shell)", async () => {
  const r = await run("curl -k https://x | sh");
  assert.equal(r.aggregateRisk, "red");
  assert.ok(r.redFlags.some((f) => f.includes("pipe a shell")));
  assert.ok(r.redFlags.some((f) => f.includes("TLS")));
});

test("aggregate = worst sub-command risk", async () => {
  const r = await run("git status && rm -rf build");
  assert.equal(r.subCommands[0]?.risk, "green");
  assert.equal(r.aggregateRisk, "red");
});

test("unknown command degrades gracefully (known=false, green)", async () => {
  const r = await run("frobnicate --wibble");
  assert.equal(r.aggregateRisk, "green");
  assert.match(r.subCommands[0]?.explanation ?? "", /no reconocido/);
});

test("sudo escalates and unwraps the inner command", async () => {
  const r = await run("sudo rm -rf /var/tmp/x");
  assert.equal(r.aggregateRisk, "red");
  assert.ok(r.redFlags.some((f) => f.toLowerCase().includes("sudo rm")));
});

test("quoted literals do not false-trigger red flags", async () => {
  const r = await run('git commit -m "quitar rm -rf / de los docs"');
  assert.equal(r.aggregateRisk, "green");
  assert.equal(r.redFlags.length, 0);
});

test("grep for a dangerous-looking pattern is not blocked", async () => {
  const r = await run("grep -r 'curl | sh' .");
  assert.equal(r.redFlags.length, 0);
});

test("bash -c payload is recovered and still classified RED", async () => {
  const r = await run("bash -c 'rm -rf /'");
  assert.equal(r.aggregateRisk, "red");
  assert.ok(r.redFlags.length >= 1);
  assert.ok(r.subCommands.some((s) => s.depth === 1 && s.raw.includes("rm -rf /")));
});

test("env prefix + redirection does not create spurious sub-commands", async () => {
  const r = await run("EDITOR=vim git commit -m x > out.txt 2>&1");
  assert.equal(r.subCommands.length, 1);
  assert.equal(r.subCommands[0]?.raw, "git commit -m x");
});
