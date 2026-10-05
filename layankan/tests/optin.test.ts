import { describe, expect, it } from "vitest";
import { isOptinAgreement, optinConfirmation, optinQuestion, shouldAskOptin, withinAnswerWindow, OPTIN_TEXT_VERSION, type AskContext } from "@/lib/optin/optin";
import { brainFromRow } from "@/lib/brain/schema";

describe("opt-in question (exact, versioned wording)", () => {
  it("names the business, says how to agree (PROMO), that no reply is fine, and how to stop", () => {
    const ms = optinQuestion("Klinik Ana", "ms");
    expect(ms).toContain("Klinik Ana");
    expect(ms).toContain("Balas PROMO untuk setuju");
    expect(ms).toContain("Tak perlu balas jika tidak mahu");
    expect(ms).toContain("STOP");
    const en = optinQuestion("Klinik Ana", "en");
    expect(en).toContain("Reply PROMO to agree");
    expect(en).toContain("STOP");
    expect(OPTIN_TEXT_VERSION).toMatch(/^optin-\d{4}-\d{2}-\d{2}\.\d+$/);
  });
  it("confirmation repeats how to stop", () => {
    expect(optinConfirmation("Klinik Ana", "ms")).toContain("STOP");
    expect(optinConfirmation("Klinik Ana", "en")).toContain("STOP");
  });
});

describe("only a clear PROMO counts as consent", () => {
  it.each(["PROMO", "promo", "Promo!", "*PROMO*", "ya promo", "Ya, promo", "yes promo", "ok promo", "setuju promo", "promo ya", "PROMO 👍", "  promo.  "])("agrees: %s", (m) => {
    expect(isOptinAgreement(m)).toBe(true);
  });
  it.each([
    "ya", "YA", "yes", "ok", "boleh", "setuju",       // could be answering the AI's own question
    "promo apa?", "ada promo tak?", "berapa harga promo", "tak nak promo", "no promo", "STOP",
    "", "promosi",
  ])("does NOT agree: %s", (m) => {
    expect(isOptinAgreement(m)).toBe(false);
  });
});

describe("when to ask (once, at a natural moment)", () => {
  const ok: AskContext = {
    enabled: true, channel: "whatsapp", isTest: false, optedOut: false, alreadyAsked: false, hasConsentRecord: false,
    handoff: false, score: "SUAM", customerMessages: 2, bookingOfferedThisTurn: false,
  };
  it("asks an engaged SUAM or PANAS WhatsApp customer", () => {
    expect(shouldAskOptin(ok)).toBe(true);
    expect(shouldAskOptin({ ...ok, score: "PANAS" })).toBe(true);
  });
  it.each([
    ["switched off", { enabled: false }],
    ["web chat (no WhatsApp number to tie consent to)", { channel: "web" }],
    ["test chat", { isTest: true }],
    ["opted out (STOP)", { optedOut: true }],
    ["already asked once", { alreadyAsked: true }],
    ["already has a consent record", { hasConsentRecord: true }],
    ["handing off to a human", { handoff: true }],
    ["SEJUK lead", { score: "SEJUK" }],
    ["no score yet", { score: null }],
    ["only one customer message so far", { customerMessages: 1 }],
    ["booking link sent this turn", { bookingOfferedThisTurn: true }],
  ])("does not ask: %s", (_l, o: Partial<AskContext>) => {
    expect(shouldAskOptin({ ...ok, ...o })).toBe(false);
  });
  it("a PROMO reply only counts within 72 hours of asking", () => {
    const now = new Date("2026-10-04T12:00:00Z");
    expect(withinAnswerWindow("2026-10-04T11:00:00Z", now)).toBe(true);
    expect(withinAnswerWindow("2026-10-01T13:00:00Z", now)).toBe(true);
    expect(withinAnswerWindow("2026-10-01T11:00:00Z", now)).toBe(false);
    expect(withinAnswerWindow(null, now)).toBe(false);
    expect(withinAnswerWindow("2026-10-05T00:00:00Z", now)).toBe(false); // in the future: never
  });
  it("is OFF by default in every Brain", () => {
    expect(brainFromRow({}).promotions.ask_optin).toBe(false);
  });
});
