/**
 * Split a command into its constituent sub-commands.
 *
 * Two axes of decomposition:
 *  1. Control operators at the top level: `&&`, `||`, `;`, `|`, `&`.
 *  2. Command substitutions: `$(...)` and backticks, extracted recursively so
 *     nested subshells are explained too.
 *
 * This is a pragmatic shell-aware scanner, not a full POSIX parser. It is
 * quote-, paren- and backtick-aware, which covers the composed commands agents
 * actually emit. It never throws on malformed input — worst case it returns the
 * whole string as one segment.
 */

import { tokenize } from "./normalize.js";

export interface DecomposedCommand {
  /** Raw sub-command text (still contains any substitutions verbatim). */
  raw: string;
  /** 0 = top-level, 1+ = inside a substitution. */
  depth: number;
}

interface ScanState {
  single: boolean;
  double: boolean;
  parenDepth: number;
  backtick: boolean;
}

/** True when the scanner is at "top level": not quoted, not nested, not in a subshell. */
function atTopLevel(s: ScanState): boolean {
  return !s.single && !s.double && !s.backtick && s.parenDepth === 0;
}

/**
 * Split a single command string on top-level control operators.
 * Returns the trimmed, non-empty segments in source order.
 */
export function splitByOperators(command: string): string[] {
  const segments: string[] = [];
  const s: ScanState = { single: false, double: false, parenDepth: 0, backtick: false };
  let start = 0;
  let i = 0;

  const push = (end: number) => {
    const seg = command.slice(start, end).trim();
    if (seg) segments.push(seg);
  };

  while (i < command.length) {
    const c = command[i]!;
    const next = command[i + 1];

    if (s.single) {
      if (c === "'") s.single = false;
      i++;
      continue;
    }
    if (s.double) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') s.double = false;
      i++;
      continue;
    }
    if (s.backtick) {
      if (c === "`") s.backtick = false;
      i++;
      continue;
    }

    switch (c) {
      case "\\":
        i += 2;
        continue;
      case "'":
        s.single = true;
        i++;
        continue;
      case '"':
        s.double = true;
        i++;
        continue;
      case "`":
        s.backtick = true;
        i++;
        continue;
      case "(":
        s.parenDepth++;
        i++;
        continue;
      case ")":
        if (s.parenDepth > 0) s.parenDepth--;
        i++;
        continue;
    }

    if (atTopLevel(s)) {
      // two-char operators
      if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
        push(i);
        i += 2;
        start = i;
        continue;
      }
      // single-char operators (| but not ||, and ;). NOT single `&`: it is
      // ambiguous with redirection syntax (`2>&1`, `&>log`) and splitting on it
      // corrupts those. Background `&` is rare in agent-emitted commands.
      if (c === "|" || c === ";") {
        push(i);
        i += 1;
        start = i;
        continue;
      }
    }
    i++;
  }
  push(command.length);
  return segments;
}

/**
 * Extract the inner text of top-level command substitutions found in `str`:
 * `$(...)` (balanced) and backtick pairs. Substitutions inside single quotes
 * are literal and skipped. Does not recurse — the caller recurses.
 */
export function findSubstitutions(str: string): string[] {
  const out: string[] = [];
  const s: ScanState = { single: false, double: false, parenDepth: 0, backtick: false };
  let i = 0;

  while (i < str.length) {
    const c = str[i]!;

    if (s.single) {
      if (c === "'") s.single = false;
      i++;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'" && !s.double) {
      s.single = true;
      i++;
      continue;
    }
    if (c === '"') {
      s.double = !s.double;
      i++;
      continue;
    }

    // backtick substitution: `...`
    if (c === "`") {
      const end = str.indexOf("`", i + 1);
      if (end === -1) break;
      out.push(str.slice(i + 1, end));
      i = end + 1;
      continue;
    }

    // $( ... ) substitution with balanced parens
    if (c === "$" && str[i + 1] === "(") {
      const inner = readBalancedParen(str, i + 2);
      if (inner) {
        out.push(inner.text);
        i = inner.end + 1;
        continue;
      }
    }

    i++;
  }
  return out;
}

/** Read from `start` until the paren opened just before `start` is balanced. */
function readBalancedParen(str: string, start: number): { text: string; end: number } | null {
  let depth = 1;
  let single = false;
  let double = false;
  let i = start;
  while (i < str.length) {
    const c = str[i]!;
    if (single) {
      if (c === "'") single = false;
      i++;
      continue;
    }
    if (double) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') double = false;
      i++;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") single = true;
    else if (c === '"') double = true;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { text: str.slice(start, i), end: i };
    }
    i++;
  }
  return null; // unbalanced — treat as no substitution
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

function basename(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

function stripOuterQuotes(tok: string): string {
  if (tok.length >= 2) {
    const a = tok[0];
    const b = tok[tok.length - 1];
    if ((a === "'" && b === "'") || (a === '"' && b === '"')) return tok.slice(1, -1);
  }
  return tok;
}

/**
 * If a segment is `sh -c '<script>'` / `bash -c "…"` (optionally sudo-prefixed),
 * return the inner script so it can be analyzed as a real sub-command. This is
 * what keeps quote-masking honest: the payload masked out for pattern matching
 * reappears here as its own decomposed command.
 */
function extractShellC(segment: string): string | null {
  const tokens = tokenize(segment);
  let i = 0;
  if (tokens[i] && basename(tokens[i]!) === "sudo") i++;
  const head = tokens[i];
  if (!head || !SHELLS.has(basename(head))) return null;
  for (let j = i + 1; j < tokens.length; j++) {
    if (tokens[j] === "-c") {
      const arg = tokens[j + 1];
      return arg ? stripOuterQuotes(arg) : null;
    }
  }
  return null;
}

/**
 * Full recursive decomposition. Returns sub-commands in source order, with the
 * outer command listed before the substitutions nested inside it.
 */
export function decompose(command: string, depth = 0): DecomposedCommand[] {
  const result: DecomposedCommand[] = [];
  for (const segment of splitByOperators(command)) {
    result.push({ raw: segment, depth });
    for (const sub of findSubstitutions(segment)) {
      result.push(...decompose(sub, depth + 1));
    }
    const script = extractShellC(segment);
    if (script && script.trim()) {
      result.push(...decompose(script, depth + 1));
    }
  }
  return result;
}
