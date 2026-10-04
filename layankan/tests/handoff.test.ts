import { describe, expect, it } from "vitest";
import { decideHandoff } from "@/lib/agent/handoff";
import { planTurn, FALLBACK_REPLY } from "@/lib/agent/interpret";
import { brain, output } from "./fixtures";

const rules = brain().handoff_rules;
const signals = output().assessment.signals;

describe("handoff policy", () => {
  it("does not hand off a normal warm enquiry", () => {
    expect(decideHandoff(output().assessment, rules)).toEqual({ handoff: false, reasons: [] });
  });

  it("hands off when customer is ready to buy", () => {
    const d = decideHandoff(output({ signals: { ...signals, ready_to_buy: true } }).assessment, rules);
    expect(d.handoff).toBe(true);
    expect(d.reasons).toContain("ready_to_buy");
  });

  it("hands off a confident PANAS lead even without the explicit signal", () => {
    expect(decideHandoff(output({ score: "PANAS", confidence: 0.9 }).assessment, rules).reasons).toContain("ready_to_buy");
  });

  it("respects the owner turning ready_to_buy off", () => {
    const off = { ...rules, ready_to_buy: false };
    expect(decideHandoff(output({ score: "PANAS", confidence: 0.9, signals: { ...signals, ready_to_buy: true } }).assessment, off).handoff).toBe(false);
  });

  it("hands off complaints and requests for a human", () => {
    expect(decideHandoff(output({ signals: { ...signals, complaint: true } }).assessment, rules).reasons).toEqual(["complaint"]);
    expect(decideHandoff(output({ signals: { ...signals, asked_for_human: true } }).assessment, rules).reasons).toEqual(["asked_for_human"]);
  });

  it("hands off when the AI is unsure or below the confidence threshold", () => {
    expect(decideHandoff(output({ signals: { ...signals, unsure: true } }).assessment, rules).reasons).toEqual(["ai_unsure"]);
    expect(decideHandoff(output({ confidence: 0.2 }).assessment, rules).reasons).toEqual(["ai_unsure"]);
  });

  it("does NOT bother the owner for low-confidence empty 'hi, harga?' enquiries", () => {
    const a = output({ score: "SEJUK", confidence: 0.3, signals: { ...signals, empty_enquiry: true } }).assessment;
    expect(decideHandoff(a, rules).handoff).toBe(false);
  });

  it("always honours the model's explicit handoff request", () => {
    const allOff = { ...rules, ready_to_buy: false, complaint: false, ai_unsure: false, asked_for_human: false };
    expect(decideHandoff(output({ handoff_required: true }).assessment, allOff).reasons).toEqual(["model_requested"]);
  });

  it("always hands off on AI error", () => {
    expect(decideHandoff(null, rules)).toEqual({ handoff: true, reasons: ["ai_error"] });
  });
});

describe("planTurn (model result → action)", () => {
  const b = brain();
  const ok = { output: output(), stopReason: "end_turn", model: "m", inputTokens: 1, outputTokens: 1 };

  it("uses the model reply on success", () => {
    const p = planTurn(ok, b, { locale: "ms" });
    expect(p.error).toBeNull();
    expect(p.replyText).toBe("Boleh! Bila nak datang?");
    expect(p.decision.handoff).toBe(false);
  });

  it("falls back + hands off on refusal", () => {
    const p = planTurn({ ...ok, output: null, stopReason: "refusal" }, b, { locale: "en" });
    expect(p.error).toMatch(/refusal/);
    expect(p.replyText).toBe(FALLBACK_REPLY.en);
    expect(p.decision).toEqual({ handoff: true, reasons: ["ai_error"] });
  });

  it("falls back + hands off on schema-invalid output", () => {
    const p = planTurn({ ...ok, output: { reply: "hi" } }, b, { locale: "ms" });
    expect(p.error).toMatch(/invalid output/);
    expect(p.replyText).toBe(FALLBACK_REPLY.ms);
    expect(p.decision.handoff).toBe(true);
  });

  it("falls back + hands off on truncated output or thrown errors", () => {
    expect(planTurn({ ...ok, stopReason: "max_tokens" }, b, { locale: "ms" }).decision.handoff).toBe(true);
    expect(planTurn(null, b, { locale: "ms", thrownError: "APIConnectionError" }).decision.handoff).toBe(true);
  });
});
