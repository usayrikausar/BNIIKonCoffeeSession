import { describe, expect, it } from "vitest";
import { withBookingLink } from "@/lib/agent/booking";
import { BookingSchema, brainFromRow } from "@/lib/brain/schema";
import { buildSystemPrompt } from "@/lib/agent/prompt";
import { planTurn } from "@/lib/agent/interpret";
import { brain, output } from "./fixtures";

const link = { url: "https://cal.com/klinik-ana", label: "" };
const panas = (reply = "Boleh! Sabtu ada slot pagi.", language: "ms" | "en" | "mixed" = "ms") => ({ ...output({ score: "PANAS" }, reply), language });

describe("booking link for PANAS leads", () => {
  it("is added to a PANAS reply, in the customer's language", () => {
    expect(withBookingLink(panas(), link, { alreadySent: false, locale: "ms" })).toEqual({
      text: "Boleh! Sabtu ada slot pagi.\n\n📅 Tempah terus di sini: https://cal.com/klinik-ana",
      offered: true,
    });
    expect(withBookingLink(panas("Sure, Saturday works.", "en"), link, { alreadySent: false, locale: "ms" }).text).toContain("📅 Book directly here: https://cal.com/klinik-ana");
    expect(withBookingLink(panas("ok boleh", "mixed"), { ...link, label: "Calendly" }, { alreadySent: false, locale: "en" }).text).toContain("Book directly here: Calendly: https://");
  });
  it("is offered only once per conversation", () => {
    expect(withBookingLink(panas(), link, { alreadySent: true, locale: "ms" })).toEqual({ text: "Boleh! Sabtu ada slot pagi.", offered: false });
  });
  it("is not added for SUAM / SEJUK leads, or when no link is set", () => {
    expect(withBookingLink(output({ score: "SUAM" }), link, { alreadySent: false, locale: "ms" }).offered).toBe(false);
    expect(withBookingLink(output({ score: "SEJUK" }), link, { alreadySent: false, locale: "ms" }).offered).toBe(false);
    expect(withBookingLink(panas(), { url: "", label: "" }, { alreadySent: false, locale: "ms" }).offered).toBe(false);
  });
  it("is not repeated when the AI already wrote it", () => {
    const r = withBookingLink(panas("Tempah sini ya: https://cal.com/klinik-ana"), link, { alreadySent: false, locale: "ms" });
    expect(r).toEqual({ text: "Tempah sini ya: https://cal.com/klinik-ana", offered: true });
  });
  it("only accepts https links (no javascript:, no plain http)", () => {
    expect(BookingSchema.safeParse({ url: "https://wa.me/60123" }).success).toBe(true);
    expect(BookingSchema.safeParse({ url: "http://example.com" }).success).toBe(false);
    expect(BookingSchema.safeParse({ url: "javascript:alert(1)" }).success).toBe(false);
    expect(BookingSchema.safeParse({ url: "https://x.com/a b" }).success).toBe(false);
  });
  it("is part of the Brain the AI knows about, and quoting it is not treated as a leak", () => {
    const b = brain({ booking: link });
    expect(buildSystemPrompt(b)).toContain("https://cal.com/klinik-ana");
    const plan = planTurn({ output: panas("Boleh tempah di https://cal.com/klinik-ana — share it when the customer wants to book"), stopReason: "end_turn", model: "m", inputTokens: 1, outputTokens: 1 }, b, { locale: "ms" });
    expect(plan.error).toBeNull();
    expect(brainFromRow({}).booking).toEqual({ url: "", label: "" });
  });
});
