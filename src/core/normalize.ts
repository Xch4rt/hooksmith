/**
 * Normalize a single sub-command for explanation:
 *  - strip leading environment-variable assignments (`EDITOR=vim git commit`)
 *  - strip redirections (`ls > out.txt 2>&1`, `cmd < in`, `cmd &> log`)
 *
 * Content inside single quotes is treated as a literal and never rewritten.
 * The result is what the explainer and the display see.
 */

const ENV_PREFIX = /^\s*[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s]*)\s+/;

export function stripEnvPrefixes(cmd: string): string {
  let out = cmd;
  while (ENV_PREFIX.test(out)) {
    out = out.replace(ENV_PREFIX, "");
  }
  return out.trim();
}

/**
 * Remove redirection operators and their targets. Tokenizes with quote
 * awareness so a `>` inside quotes is left alone.
 */
export function stripRedirections(cmd: string): string {
  const tokens = tokenize(cmd);
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    // Forms: >, >>, <, <<, <<<, N>, N>>, &>, >&, N>&M, N<&M
    const redir = /^(?:[0-9]*(?:>>?|<<?<?)|&>>?|>&|[0-9]*[<>]&[0-9-]*)$/;
    if (redir.test(t)) {
      // "2>&1" / ">&2" already embed their target; a bare ">"/">>"/"<" consumes the next token.
      if (/^(?:[0-9]*>>?|[0-9]*<<?<?|&>>?)$/.test(t) && !/&/.test(t)) {
        i++; // skip the redirection target token
      }
      continue;
    }
    // Glued redirection like ">out.txt" or "2>err.log"
    const glued = /^(?:[0-9]*>>?|[0-9]*<|&>>?)[^\s].*$/;
    if (glued.test(t)) continue;
    kept.push(t);
  }
  return kept.join(" ").trim();
}

/** Whitespace-split that keeps quoted spans intact. */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let single = false;
  let double = false;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (single) {
      cur += c;
      if (c === "'") single = false;
      continue;
    }
    if (double) {
      cur += c;
      if (c === '"') double = false;
      continue;
    }
    if (c === "'") {
      single = true;
      cur += c;
      has = true;
      continue;
    }
    if (c === '"') {
      double = true;
      cur += c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += c;
    has = true;
  }
  if (has) tokens.push(cur);
  return tokens;
}

export function normalize(cmd: string): string {
  return stripRedirections(stripEnvPrefixes(cmd));
}

/**
 * Replace the *contents* of quoted spans with spaces, preserving length,
 * delimiters and everything unquoted. Used before red-flag pattern matching so
 * a dangerous-looking literal (`echo "rm -rf /"`, a commit message, a grep
 * pattern) does not trigger a false positive, while unquoted structure such as
 * `curl … | sh` still matches. The real payload of `bash -c '…'` is recovered
 * separately by the decomposer, so masking does not create an evasion hole.
 */
export function maskQuotedLiterals(cmd: string): string {
  let out = "";
  let single = false;
  let double = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (single) {
      out += c === "'" ? ((single = false), "'") : " ";
      continue;
    }
    if (double) {
      if (c === "\\") {
        out += "  ";
        i++;
        continue;
      }
      out += c === '"' ? ((double = false), '"') : " ";
      continue;
    }
    if (c === "'") {
      single = true;
      out += "'";
      continue;
    }
    if (c === '"') {
      double = true;
      out += '"';
      continue;
    }
    out += c;
  }
  return out;
}

export { tokenize };
