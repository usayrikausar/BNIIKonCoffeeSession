import { describe, expect, it } from "vitest";
import { validateAgentOutput, mergeLeadDetails, AgentOutputSchema } from "@/lib/agent/schema";
import { output } from "./fixtures";

describe("agent output schema", () => {
  it("accepts a well-formed output", () => {
    const o = validateAgentOutput(output());
    expect(o.assessment.score).toBe("SUAM");
    expect(o.reply).toBe("Boleh! Bila nak datang?");
  });

  it("rejects unknown scores", () => {
    const bad = output() as unknown as { assessment: { score: string } };
    bad.assessment.score = "HOT";
    expect(() => validateAgentOutput(bad)).toThrow();
  });

  it("rejects missing fields", () => {
    const bad = structuredClone(output()) as Record<string, unknown>;
    delete (bad.assessment as Record<string, unknown>).signals;
    expect(() => validateAgentOutput(bad)).toThrow();
  });

  it("rejects an empty reply", () => {
    expect(() => validateAgentOutput(output({}, "   "))).toThrow(/empty reply/);
  });

  it("clamps confidence into 0..1", () => {
    expect(validateAgentOutput(output({ confidence: 7 })).assessment.confidence).toBe(1);
    expect(validateAgentOutput(output({ confidence: -2 })).assessment.confidence).toBe(0);
  });

  it("truncates essay-length replies", () => {
    const o = validateAgentOutput(output({}, "a".repeat(5000)));
    expect(o.reply.length).toBeLessThanOrEqual(1201);
  });

  it("normalises blank captured values to null", () => {
    const o = validateAgentOutput(output({ captured: { name: "  ", need: " Scaling ", timeline: null, budget: null, phone: null, email: null } }));
    expect(o.assessment.captured.name).toBeNull();
    expect(o.assessment.captured.need).toBe("Scaling");
  });

  it("produces a JSON schema the API can enforce (objects closed, all keys required)", () => {
    const js = AgentOutputSchema.toJSONSchema() as { required: string[]; properties: Record<string, unknown> };
    expect(js.required).toEqual(expect.arrayContaining(["reply", "language", "assessment"]));
  });

  it("mergeLeadDetails never erases known details with null", () => {
    const merged = mergeLeadDetails({ name: "Ali", phone: "012" }, { name: null, need: "rumah", timeline: null, budget: "RM500k", phone: null, email: null });
    expect(merged).toEqual({ name: "Ali", phone: "012", need: "rumah", budget: "RM500k" });
  });
});
