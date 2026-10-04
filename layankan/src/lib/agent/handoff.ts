import type { Assessment } from "./schema";
import type { Brain } from "@/lib/brain/schema";

export type HandoffReason =
  | "model_requested"
  | "ready_to_buy"
  | "complaint"
  | "asked_for_human"
  | "ai_unsure"
  | "ai_error";

export interface HandoffDecision {
  handoff: boolean;
  reasons: HandoffReason[];
}

/**
 * Deterministic handoff policy. The model proposes (handoff_required +
 * signals); the owner's rules decide. Pure function → easy to test/audit.
 *
 * - The model's explicit handoff_required is always honoured (it is told the
 *   owner's rules and only sets it when a human is genuinely needed).
 * - A failed/refused AI turn always hands off: a customer must never be left
 *   without a response path.
 */
export function decideHandoff(
  assessment: Assessment | null,
  rules: Brain["handoff_rules"],
  ctx: { aiError?: boolean } = {},
): HandoffDecision {
  const reasons: HandoffReason[] = [];
  if (ctx.aiError || !assessment) {
    return { handoff: true, reasons: ["ai_error"] };
  }
  const s = assessment.signals;
  if (assessment.handoff_required) reasons.push("model_requested");
  if (rules.ready_to_buy && (s.ready_to_buy || (assessment.score === "PANAS" && assessment.confidence >= 0.7))) {
    reasons.push("ready_to_buy");
  }
  if (rules.complaint && s.complaint) reasons.push("complaint");
  if (rules.asked_for_human && s.asked_for_human) reasons.push("asked_for_human");
  if (rules.ai_unsure && (s.unsure || assessment.confidence < rules.min_confidence)) {
    // Low confidence on an empty "hi, harga?" enquiry is expected, not a reason
    // to bother the owner — the AI keeps qualifying instead.
    if (s.unsure || !s.empty_enquiry) reasons.push("ai_unsure");
  }
  return { handoff: reasons.length > 0, reasons };
}

export const HANDOFF_REASON_LABELS: Record<HandoffReason, { ms: string; en: string }> = {
  model_requested: { ms: "AI minta bantuan manusia", en: "AI requested a human" },
  ready_to_buy: { ms: "Pelanggan sedia membeli", en: "Customer ready to buy" },
  complaint: { ms: "Aduan", en: "Complaint" },
  asked_for_human: { ms: "Pelanggan minta bercakap dengan orang", en: "Customer asked for a person" },
  ai_unsure: { ms: "AI tidak pasti jawapan", en: "AI unsure of the answer" },
  ai_error: { ms: "AI gagal menjawab", en: "AI failed to respond" },
};
