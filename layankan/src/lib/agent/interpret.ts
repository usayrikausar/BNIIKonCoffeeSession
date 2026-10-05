import type { Brain } from "@/lib/brain/schema";
import { decideHandoff, type HandoffDecision } from "./handoff";
import { detectInstructionLeak } from "./leak-guard";
import type { LlmResult } from "./llm";
import { validateAgentOutput, type AgentOutput } from "./schema";

export const FALLBACK_REPLY = {
  ms: "Maaf, saya perlu semak dengan pasukan kami dahulu. Seorang wakil akan membalas anda sebentar lagi 🙏",
  en: "Sorry, let me check with our team first. Someone will get back to you shortly 🙏",
} as const;

export interface TurnPlan {
  output: AgentOutput | null;
  error: string | null;
  decision: HandoffDecision;
  replyText: string;
}

/**
 * Turns a raw model result into what the engine should do. Pure: no I/O.
 * Any failure (refusal, invalid JSON, schema violation, exception) produces a
 * safe fallback reply AND a handoff, so the customer is never stranded and the
 * AI never improvises outside the schema.
 */
export function planTurn(
  result: LlmResult | null,
  brain: Brain,
  opts: { locale: "ms" | "en"; thrownError?: string | null },
): TurnPlan {
  let output: AgentOutput | null = null;
  let error: string | null = opts.thrownError ?? null;

  if (!error) {
    if (!result) error = "no result";
    else if (result.stopReason === "refusal") error = "model refusal";
    else if (result.stopReason === "max_tokens") error = "model output truncated (max_tokens)";
    else if (result.output == null) error = "no structured output";
    else {
      try {
        output = validateAgentOutput(result.output);
      } catch (e) {
        error = `invalid output: ${e instanceof Error ? e.message.slice(0, 300) : "unknown"}`;
      }
    }
  }

  // A reply that leaks our instructions is never sent: fallback + handoff.
  if (output) {
    const leak = detectInstructionLeak(output.reply, brain);
    if (leak) {
      error = `blocked: ${leak}`;
      output = null;
    }
  }

  const decision = decideHandoff(output?.assessment ?? null, brain.handoff_rules, { aiError: !!error });
  const replyText = output ? output.reply : FALLBACK_REPLY[opts.locale];
  return { output, error, decision, replyText };
}
