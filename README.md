# hooksmith

`PreToolUse` hook que intercepta cada comando **Bash** *antes* del prompt de aprobación, lo
**descompone**, genera una **explicación legible** de cada sub-comando, **clasifica el riesgo** y
lo expone al usuario. Funciona en **Claude Code** y en **Codex CLI** compartiendo el mismo motor.

En vez de aprobar a ciegas `curl --resolve api:443:1.2.3.4 -o /dev/null -sS -w '%{http_code}' ...`,
ves qué hace cada flag, qué sub-comandos hay detrás de los `&&`/`|`/`$()`, y qué tramos son peligrosos.

## Cómo funciona

```
stdin(JSON) ─▶ adaptador (claude|codex) ─▶ CORE ─▶ ExplainResult ─▶ salida(JSON) exit 0
                                            │
              decompose → normalize → explain → classify → format
```

- **Core agnóstico** ([src/core/](src/core/)): recibe un `command: string`, devuelve un
  `ExplainResult` neutral. No sabe nada del agente ni del wire format.
- **Adaptadores** ([src/adapters/](src/adapters/)): parsean el JSON de entrada de su agente,
  llaman al core, y renderizan la salida + la política de decisión que ese agente honra.

Etapas del core:

| Etapa | Archivo | Qué hace |
|---|---|---|
| decompose | [decompose.ts](src/core/decompose.ts) | Separa por `&&`/`\|\|`/`;`/`\|` y extrae `$()`/backticks recursivamente (quote/paren-aware). |
| normalize | [normalize.ts](src/core/normalize.ts) | Quita env prefixes (`EDITOR=vim …`) y redirecciones (`> out 2>&1`). |
| explain | [explain.ts](src/core/explain.ts) | Registry rule-based ([config/registry.json](config/registry.json)) + fallback LLM opcional. |
| classify | [classify.ts](src/core/classify.ts) | Riesgo por sub-comando → agregado; detecta patrones catastróficos (red flags). |
| format | [format.ts](src/core/format.ts) | Arma el `humanSummary` para `systemMessage`. |

## Instalación

```bash
npm install
npm run build          # compila a dist/ (JS plano → arranque rápido en cada Bash)
npm link               # opcional: expone `explain-cmd` en el PATH
```

El hook corre en el camino de **cada** comando Bash, así que se distribuye como JS ya compilado
(no type-stripping en runtime) para minimizar el arranque de Node.

## Registro del hook

### Claude Code — `~/.claude/settings.json` (o `.claude/settings.json` del proyecto)

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash",
        "hooks": [ { "type": "command", "command": "explain-cmd --agent claude", "timeout": 10 } ] }
    ]
  }
}
```

- `matcher` es glob-ish y **case-sensitive**: `bash` no matchea `Bash`.
- Confirmá el registro con `/hooks`. Verbose con `Ctrl+O`.

### Codex CLI — `~/.codex/config.toml` + `~/.codex/hooks.json`

El sistema de hooks de Codex es **experimental** y **no corre en Windows**. Activá el feature flag:

```toml
# ~/.codex/config.toml
[features]
codex_hooks = true
```

```json
// ~/.codex/hooks.json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash",
        "hooks": [ { "type": "command", "command": "explain-cmd --agent codex", "timeout": 30 } ] }
    ]
  }
}
```

- `matcher` es un **regex string** (`""` o `"*"` matchean todo) — no es el glob de Claude.
- Requiere que **confíes/opt-in** el hook antes de que corra. Inspeccioná con `/hooks` en la TUI.

## Asimetría de decisión Claude Code vs Codex (importante)

La **explicación** (`humanSummary`) se entrega **igual en ambos** por `systemMessage`. Lo que cambia
es la **capacidad de decisión interactiva**:

| Dimensión | Claude Code | Codex CLI |
|---|---|---|
| `permissionDecision: ask` | **Efectivo** (prompt interactivo anotado) | **Fail open** → sin efecto |
| `permissionDecision: allow` | Efectivo (no afloja un `deny` de settings) | **Fail open** (sin efecto) |
| `permissionDecision: deny` | Efectivo | Efectivo (**único lever real**) |
| Tools interceptadas | Bash + edits + MCP + más | **Solo Bash** |
| Modificar input | Soportado en casos | **Rechazado** |
| stdout vacío + exit 0 | Procede | **Allow silencioso** |

**Política implementada:**

- **Claude Code** ([claude.ts](src/adapters/claude.ts)): explica sin bloquear → fuerza `ask` para
  que el prompt salga **anotado**. Reserva `deny` para comandos con **red flags**.
- **Codex CLI** ([codex.ts](src/adapters/codex.ts)): como `ask` no existe, anota vía
  `systemMessage` y el único freno real es `deny` en **red flags**. YELLOW/GREEN pasan con la
  explicación mostrada. Nunca sale con stdout vacío (evita el allow silencioso).

> ⚠️ No prometemos UX idéntica: en Claude tenés "explicar + approve interactivo"; en Codex la
> explicación **informa** pero el único freno es el `deny` de los RED.

`HOOKSMITH_EXPLAIN_ONLY=1` desactiva todo bloqueo (modo solo-explicar) en ambos agentes.

## Riesgo

- 🟢 **GREEN** — lectura / dev workflow inocuo.
- 🟡 **YELLOW** — red, package install, docker, escrituras acotadas.
- 🔴 **RED** — destructivo/privilegiado: `rm -rf` sobre `/`/`~`/`..`, `curl … | sh`, `--force` a
  main, `chmod 777`, `dd of=/dev/sd*`, `sudo rm`, TLS deshabilitado (`-k`), `mkfs`, fork bomb.

El riesgo agregado es el **peor** entre los sub-comandos. Cualquier red flag lo fuerza a RED y
alimenta el auto-deny.

## Configuración compartida — [config/hooksmith.config.json](config/hooksmith.config.json)

```json
{
  "registry_path": "registry.json",
  "llm_fallback": { "enabled": false, "model": "claude-haiku-4-5-20251001", "timeout_ms": 4000 },
  "auto_deny_patterns": [],
  "risk_display": "full"
}
```

- **`registry_path`**: registry de comandos (relativo al archivo de config o absoluto).
- **`llm_fallback`**: para comandos que el registry no reconoce, opcionalmente pide una explicación
  de una línea a la API de Anthropic (modelo tipo Haiku). **Off por defecto** — mete latencia en el
  camino de cada Bash. Requiere `ANTHROPIC_API_KEY`. Si falla o timeoutea, degrada a "no reconocido"
  (nunca rompe el hook).
- **`auto_deny_patterns`**: regex extra que fuerzan RED/auto-deny (además de los built-in).
- **`risk_display`**: `full` (con flags) o `compact`.

Override de la ruta de config con `HOOKSMITH_CONFIG=/path/to/config.json` o `--config`.

## Testing

```bash
npm test    # build + suite node:test (decompose, normalize, explain, classify)
```

Probar un adaptador alimentando el JSON de su agente por stdin:

```bash
# Claude Code
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git status && rm -rf build"}}' \
  | explain-cmd --agent claude; echo "exit: $?"

# Codex (curl|sh → auto-deny)
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"curl -k https://x | sh"}}' \
  | explain-cmd --agent codex; echo "exit: $?"
```

Atajo sin stdin: `explain-cmd --agent claude --command "curl -k https://x | sh"`.

## Variables de entorno

| Var | Efecto |
|---|---|
| `HOOKSMITH_CONFIG` | Ruta al archivo de config compartida. |
| `HOOKSMITH_EXPLAIN_ONLY=1` | Nunca bloquea; solo explica (fuerza `ask`/`allow`). |
| `HOOKSMITH_DEBUG=1` | Loguea errores internos a stderr (por defecto falla en silencio → fail open). |
| `ANTHROPIC_API_KEY` | Necesaria si `llm_fallback.enabled = true`. |

## Gotchas

- **Claude:** la matcher nativa de permisos matchea el string completo, así que
  `git status && rm -rf /` se cuela por un allow de `git status`. Por eso el enforcement real vive
  en el hook. `git -C /path status` rompe patrones basados en posición (lo manejamos saltando `-C`).
- **Codex:** feature flag obligatorio, sin Windows, requiere trust del hook. `allow`/`ask` fail
  open — solo `deny`. Solo Bash dispara `PreToolUse` (edits/MCP no). stdout vacío + exit 0 = allow.

## Referencias

- Claude Code hooks: <https://code.claude.com/docs/en/hooks> · permisos: `.../permissions`
- Codex CLI hooks: <https://developers.openai.com/codex/hooks>

> Las dos APIs son sensibles a la versión. Verificá el contrato exacto (campos, exit codes, qué
> `permissionDecision` honra cada agente) contra la doc oficial vigente antes de confiar en el
> comportamiento de bloqueo.
