import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { AgentOutputSchema } from "./schema";
import { env } from "@/lib/env";

export interface LlmResult {
  output: unknown | null; // parsed JSON (validated later), null on refusal/failure
  stopReason: string | null;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type AgentLlm = (system: string, userTurn: string) => Promise<LlmResult>;

let client: Anthropic | null = null;
function getClient() {
  client ??= new Anthropic();
  return client;
}

/** Calls Claude once per customer message: reply + lead assessment as one structured object. */
export const callClaude: AgentLlm = async (system, userTurn) => {
  const model = env.anthropicModel();
  const fallbacks = env.anthropicFallbacks();
  const response = await getClient().beta.messages.parse(
    {
      model,
      max_tokens: 8000,
      // Stable per tenant (no timestamps) → cached across turns.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userTurn }],
      output_config: { effort: env.anthropicEffort(), format: betaZodOutputFormat(AgentOutputSchema) },
      ...(fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    },
    { timeout: 60_000 },
  );
  return {
    output: response.stop_reason === "refusal" ? null : (response.parsed_output ?? null),
    stopReason: response.stop_reason ?? null,
    model: response.model ?? model,
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
  };
};
