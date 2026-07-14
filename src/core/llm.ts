import type { Risk } from "./types.js";
import type { LlmFallbackConfig } from "./config.js";

export interface LlmExplanation {
  explanation: string;
  risk: Risk;
}

/**
 * Optional one-line explanation for a command the registry doesn't know.
 * Zero-dependency call to the Anthropic Messages API via fetch. Any failure
 * (no key, timeout, bad response) resolves to null — the hook must never break
 * because the LLM did. Only called when the registry returns "unknown" AND
 * fallback is enabled in config.
 */
export async function llmExplain(
  command: string,
  cfg: LlmFallbackConfig,
): Promise<LlmExplanation | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!cfg.enabled || !apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeout_ms);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 200,
        system:
          "Eres un clasificador de comandos de shell. Devuelve SOLO JSON " +
          '{"explanation": "<una línea en español>", "risk": "green|yellow|red"}. ' +
          "risk=green lectura/dev inocuo, yellow red/instalación/escrituras acotadas, " +
          "red destructivo o privilegiado.",
        messages: [{ role: "user", content: `Comando: ${command}` }],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((c) => c.type === "text")?.text ?? "";
    const parsed = JSON.parse(extractJson(text)) as Partial<LlmExplanation>;
    const risk: Risk =
      parsed.risk === "red" || parsed.risk === "yellow" || parsed.risk === "green"
        ? parsed.risk
        : "yellow";
    if (!parsed.explanation) return null;
    return { explanation: `(LLM) ${parsed.explanation}`, risk };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start !== -1 && end !== -1 ? text.slice(start, end + 1) : "{}";
}
