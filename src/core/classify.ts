import type { Risk } from "./types.js";
import { maxRisk } from "./types.js";
import type { HooksmithConfig } from "./config.js";
import { maskQuotedLiterals } from "./normalize.js";

export interface RedFlagPattern {
  pattern: RegExp;
  reason: string;
}

/**
 * Built-in catastrophic patterns. Matched against the FULL original command so
 * cross-operator forms (`curl … | sh`) are caught even though decomposition
 * splits them into separate sub-commands.
 */
export const BUILTIN_RED_FLAGS: RedFlagPattern[] = [
  {
    pattern: /\brm\s+(?:-[A-Za-z]*\s+)*-?[A-Za-z]*r[A-Za-z]*f|rm\s+(?:-[A-Za-z]*\s+)*-?[A-Za-z]*f[A-Za-z]*r/,
    reason: "rm recursivo y forzado (-rf): borra árboles de directorios sin confirmación",
  },
  {
    pattern: /\brm\s+-[A-Za-z]*\s+(?:\/|~|\.\.|\$HOME)(?:\s|\/|$)/,
    reason: "rm apuntando a /, ~, $HOME o .. : puede destruir el sistema o el home",
  },
  {
    pattern: /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python[0-9.]*|node)\b/,
    reason: "pipe a shell (curl … | sh): descarga y ejecuta código remoto sin inspección",
  },
  {
    pattern: /\bcurl\b[^\n]*\s(?:-k|--insecure)\b/,
    reason: "curl con TLS deshabilitado (-k/--insecure): vulnerable a man-in-the-middle",
  },
  {
    pattern: /\bchmod\s+(?:-[A-Za-z]*\s+)*777\b/,
    reason: "chmod 777: permisos totales para todos los usuarios",
  },
  {
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(?:sd|disk|nvme|hd|vd)/,
    reason: "dd escribiendo a un dispositivo de bloque: destruye datos del disco",
  },
  {
    pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/,
    reason: "mkfs: formatea un sistema de archivos (borra el dispositivo)",
  },
  {
    pattern: /\bsudo\s+rm\b/,
    reason: "sudo rm: borrado con privilegios de root",
  },
  {
    pattern: /\bgit\s+(?:-C\s+\S+\s+)?push\b[^\n]*\s(?:--force|-f)\b(?![\w-])[^\n]*\b(?:main|master|origin)\b/,
    reason: "git push --force a una rama principal: reescribe historia compartida",
  },
  {
    pattern: />\s*\/dev\/(?:sd|disk|nvme|hd|vd)/,
    reason: "redirección a un dispositivo de bloque: corrompe el disco",
  },
  {
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: "fork bomb: agota los recursos del sistema",
  },
];

export interface ClassifyResult {
  redFlags: string[];
  aggregateRisk: Risk;
}

export interface ClassifySubject {
  raw: string;
  risk: Risk;
}

/**
 * Compute the aggregate risk and the list of red-flag reasons.
 *
 * Patterns are matched against quote-masked text so literals never false-trigger.
 * Matching runs against BOTH the full command (to catch cross-operator forms
 * like `curl … | sh`) and each individual sub-command (so payloads recovered
 * from `$()` / `bash -c '…'` are still checked). Reasons are de-duplicated.
 *
 * @param fullCommand  the original, un-decomposed command
 * @param subjects     decomposed sub-commands with their base risks
 */
export function classify(
  fullCommand: string,
  subjects: ClassifySubject[],
  config: HooksmithConfig,
): ClassifyResult {
  const found = new Set<string>();
  const haystacks = [fullCommand, ...subjects.map((s) => s.raw)].map(maskQuotedLiterals);

  const userPatterns = (config.auto_deny_patterns ?? [])
    .map(({ pattern, reason }) => {
      try {
        return { pattern: new RegExp(pattern), reason };
      } catch {
        return null; // ignore malformed user regex
      }
    })
    .filter((p): p is RedFlagPattern => p !== null);

  for (const text of haystacks) {
    for (const { pattern, reason } of BUILTIN_RED_FLAGS) {
      if (pattern.test(text)) found.add(reason);
    }
    for (const { pattern, reason } of userPatterns) {
      if (pattern.test(text)) found.add(reason);
    }
  }

  const redFlags = [...found];
  let aggregate = maxRisk(subjects.map((s) => s.risk));
  if (redFlags.length > 0) aggregate = "red";
  return { redFlags, aggregateRisk: aggregate };
}
