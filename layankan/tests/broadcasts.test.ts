import { describe, expect, it } from "vitest";
import {
  AudienceSchema, CreateBroadcastSchema, dailyCap, DEFAULT_DAILY_CAP, inSendingHours, matchesAudience, renderVariables, templateProblem, type TemplateRow,
} from "@/lib/broadcasts/rules";
import { isOptOut } from "@/lib/channels/whatsapp/policy";

const tpl = (o: Partial<TemplateRow> = {}): TemplateRow => ({
  name: "promo_raya", language: "ms", status: "APPROVED", category: "MARKETING", source: "meta_sync",
  body_text: "Hai {{1}}! Diskaun Raya 20% di {{2}}. Balas STOP untuk berhenti.", variable_count: 2, ...o,
});

describe("templateProblem", () => {
  it("accepts an approved MARKETING template synced from Meta, with an opt-out line", () => {
    expect(templateProblem(tpl())).toBeNull();
    expect(templateProblem(tpl({ body_text: "Promo! Balas BERHENTI jika tidak mahu." }))).toBeNull();
    expect(templateProblem(tpl({ status: "approved", category: "marketing" }))).toBeNull();
  });
  it("refuses templates the owner typed in themselves", () => {
    expect(templateProblem(tpl({ source: "manual" }))).toBe("not_synced");
  });
  it("refuses unapproved, non-marketing, or no-opt-out templates", () => {
    expect(templateProblem(tpl({ status: "PENDING" }))).toBe("not_approved");
    expect(templateProblem(tpl({ category: "UTILITY" }))).toBe("not_marketing");
    expect(templateProblem(tpl({ category: null }))).toBe("not_marketing");
    expect(templateProblem(tpl({ body_text: "Diskaun Raya 20%!" }))).toBe("no_opt_out_line");
    expect(templateProblem(tpl({ body_text: "Unstoppable deals!" }))).toBe("no_opt_out_line");
  });
});

describe("sending rules", () => {
  it("only 9am–9pm", () => {
    expect(inSendingHours(8)).toBe(false);
    expect(inSendingHours(9)).toBe(true);
    expect(inSendingHours(20)).toBe(true);
    expect(inSendingHours(21)).toBe(false);
  });
  it("daily cap defaults to Meta's lowest tier, can be raised per number", () => {
    expect(dailyCap({})).toBe(DEFAULT_DAILY_CAP);
    expect(dailyCap(null)).toBe(DEFAULT_DAILY_CAP);
    expect(dailyCap({ broadcast_daily_limit: 1000 })).toBe(1000);
    expect(dailyCap({ broadcast_daily_limit: -5 })).toBe(DEFAULT_DAILY_CAP);
    expect(dailyCap({ broadcast_daily_limit: "abc" })).toBe(DEFAULT_DAILY_CAP);
  });
  it("fills {name} / {business}; never sends an empty variable", () => {
    expect(renderVariables(["{name}", "{business}"], { name: "Aisyah Rahman", business: "Kedai H" }, "ms")).toEqual(["Aisyah", "Kedai H"]);
    expect(renderVariables(["{name}"], { name: null, business: "X" }, "ms")).toEqual(["pelanggan"]);
    expect(renderVariables(["{name}"], { name: "", business: "X" }, "en")).toEqual(["there"]);
    expect(renderVariables(["", "line\nbreak"], { name: "A", business: "X" }, "ms")).toEqual(["-", "line break"]);
  });
  it("audience by lead score (empty = everyone)", () => {
    const all = AudienceSchema.parse({});
    expect(matchesAudience("SEJUK", all)).toBe(true);
    expect(matchesAudience(null, all)).toBe(true);
    const hot = AudienceSchema.parse({ scores: ["PANAS", "SUAM"] });
    expect(matchesAudience("PANAS", hot)).toBe(true);
    expect(matchesAudience("SEJUK", hot)).toBe(false);
    expect(matchesAudience(null, hot)).toBe(false);
    expect(AudienceSchema.safeParse({ scores: ["VIP"] }).success).toBe(false);
  });
  it("creating needs the owner's explicit confirmation", () => {
    const base = { name: "Promo", template_name: "promo_raya", template_language: "ms", variables: [], audience: { scores: [] } };
    expect(CreateBroadcastSchema.safeParse({ ...base, confirm: true }).success).toBe(true);
    expect(CreateBroadcastSchema.safeParse({ ...base, confirm: false }).success).toBe(false);
    expect(CreateBroadcastSchema.safeParse(base).success).toBe(false);
    expect(CreateBroadcastSchema.safeParse({ ...base, template_name: "Bad Name", confirm: true }).success).toBe(false);
  });
});

describe("STOP from a promotion's quick-reply button", () => {
  it("recognises the button texts as opt-outs", () => {
    for (const t of ["Stop promotions", "STOP PROMOSI", "Berhenti promosi", "henti promo", "stop", "BERHENTI", "tak nak terima promosi"]) expect(isOptOut(t), t).toBe(true);
  });
  it("doesn't treat normal sentences as STOP", () => {
    for (const t of ["stop dekat mana?", "bila promo berhenti?", "promosi stop bila"]) expect(isOptOut(t), t).toBe(false);
  });
});
