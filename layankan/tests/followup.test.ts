import { describe, expect, it } from "vitest";
import { planFollowUp, templatePreview, type FollowUpCandidate } from "@/lib/followup/plan";
import { brainFromRow, FollowUpSchema } from "@/lib/brain/schema";

const now = new Date("2026-10-04T03:00:00Z"); // 11:00 in KL
const cfg = FollowUpSchema.parse({ enabled: true, delay_hours: 24, max_attempts: 1, message: "Hai {name}, masih berminat dengan {need}?", template_name: "susulan_suam", template_variables: ["{name}", "{need}"] });
const base: FollowUpCandidate = {
  lead_score: "SUAM",
  status: "ai",
  is_test: false,
  channel: "whatsapp",
  follow_up_count: 0,
  last_follow_up_at: null,
  last_message_at: "2026-10-03T01:00:00Z", // 26h ago
  last_inbound_at: "2026-10-03T00:59:00Z",
  lead_details: { name: "Ali", need: "pakej setup" },
};
const ctx = { now, localHour: 11, lastSender: "ai", optedOut: false, businessName: "Klinik Ana" };

describe("SUAM follow-up planner", () => {
  it("uses an approved template once the 24h window has closed", () => {
    expect(planFollowUp(base, cfg, ctx)).toEqual({ action: "template", template: { name: "susulan_suam", language: "ms", variables: ["Ali", "pakej setup"] } });
  });

  it("uses free text while the window is still open", () => {
    const c = { ...base, last_message_at: "2026-10-03T02:00:00Z", last_inbound_at: "2026-10-03T04:00:00Z" };
    const p = planFollowUp(c, { ...cfg, delay_hours: 20 }, ctx);
    expect(p).toEqual({ action: "freeform", text: "Hai Ali, masih berminat dengan pakej setup?" });
  });

  it.each([
    ["disabled", { cfg: { ...cfg, enabled: false } }],
    ["not SUAM", { c: { lead_score: "PANAS" } }],
    ["not AI-handled", { c: { status: "needs_human" } }],
    ["off for this chat", { c: { follow_up_disabled: true } }],
    ["test", { c: { is_test: true } }],
    ["channel", { c: { channel: "web" } }],
    ["max attempts", { c: { follow_up_count: 1 } }],
    ["too soon", { c: { last_message_at: "2026-10-03T12:00:00Z" } }],
    ["opted out", { ctx: { optedOut: true } }],
    ["customer spoke last", { ctx: { lastSender: "customer" } }],
    ["quiet hours", { ctx: { localHour: 22 } }],
    ["window closed and no template configured", { cfg: { ...cfg, template_name: "" } }],
  ])("skips: %s", (reason, o: { cfg?: typeof cfg; c?: Partial<FollowUpCandidate>; ctx?: Partial<typeof ctx> }) => {
    expect(planFollowUp({ ...base, ...o.c }, o.cfg ?? cfg, { ...ctx, ...o.ctx })).toEqual({ action: "skip", reason });
  });

  it("sends at most 2, each after its own owner-set interval", () => {
    const two = { ...cfg, max_attempts: 2, delay_hours: 24, second_delay_hours: 72 };
    // first nudge: 24h after the chat went quiet
    expect(planFollowUp(base, two, ctx).action).toBe("template");
    // second nudge: 72h after the first, not 24h
    const afterFirst = { ...base, follow_up_count: 1, last_follow_up_at: "2026-10-02T03:00:00Z", last_message_at: "2026-10-02T03:00:00Z" }; // 48h ago
    expect(planFollowUp(afterFirst, two, ctx)).toEqual({ action: "skip", reason: "too soon" });
    const later = { ...afterFirst, last_follow_up_at: "2026-10-01T02:00:00Z", last_message_at: "2026-10-01T02:00:00Z" }; // 73h ago
    expect(planFollowUp(later, two, ctx).action).toBe("template");
    // never a third, even if old settings asked for 3
    expect(planFollowUp({ ...later, follow_up_count: 2 }, { ...two, max_attempts: 3 as 2 }, ctx)).toEqual({ action: "skip", reason: "max attempts" });
  });

  it("old saved settings with 3 follow-ups load as 2 instead of breaking the Brain", () => {
    const b = brainFromRow({ profile: { name: "X" }, follow_up: { enabled: true, max_attempts: 3 } });
    expect(b.profile.name).toBe("X");
    expect(b.follow_up.max_attempts).toBe(2);
    expect(b.follow_up.second_delay_hours).toBe(72);
  });

  it("renders a readable template preview for our history", () => {
    expect(templatePreview("Hai {{1}}, masih berminat dengan {{2}}?", "x", ["Ali", "rumah"])).toBe("Hai Ali, masih berminat dengan rumah?");
    expect(templatePreview("", "susulan", ["Ali"])).toBe("[Template: susulan] Ali");
  });
});
