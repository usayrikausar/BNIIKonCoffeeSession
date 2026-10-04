import { BrainSchema, type Brain } from "@/lib/brain/schema";
import type { AgentOutput } from "@/lib/agent/schema";

export function brain(overrides: Partial<Brain> = {}): Brain {
  return BrainSchema.parse({
    profile: { name: "Klinik Ana", industry: "klinik", tone: "santai", languages: ["ms", "en"] },
    products: [{ name: "Cuci gigi", price: "RM80", description: "Scaling & polishing", suits: "Dewasa" }],
    faqs: [{ q: "Buka hari Ahad?", a: "Tidak, Isnin–Sabtu sahaja." }],
    qualifying_questions: ["Rawatan apa?", "Bila nak datang?"],
    ...overrides,
  });
}

export function output(over: Partial<AgentOutput["assessment"]> = {}, reply = "Boleh! Bila nak datang?"): AgentOutput {
  return {
    reply,
    language: "ms",
    assessment: {
      score: "SUAM",
      confidence: 0.8,
      reason: "Berminat, masa belum pasti",
      captured: { name: null, need: "cuci gigi", timeline: null, budget: null, phone: null, email: null },
      next_action: "Tanya tarikh",
      handoff_required: false,
      handoff_reason: null,
      signals: { ready_to_buy: false, complaint: false, asked_for_human: false, unsure: false, empty_enquiry: false },
      ...over,
    },
  };
}
