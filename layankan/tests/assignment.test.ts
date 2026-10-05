import { describe, expect, it } from "vitest";
import { canTakeOver, heldBy, memberName } from "@/lib/chat/assignment";

const A = "00000000-0000-0000-0000-0000000000aa";
const B = "00000000-0000-0000-0000-0000000000bb";
const members = [
  { user_id: A, email: "aisyah@klinik.my", display_name: "Aisyah" },
  { user_id: B, email: "bala@klinik.my", display_name: null },
];

describe("shared inbox assignment (first to take it)", () => {
  it("a chat is held only while a person is handling it", () => {
    expect(heldBy({ status: "human", assigned_to: A })).toBe(A);
    expect(heldBy({ status: "needs_human", assigned_to: A })).toBe(A);
    expect(heldBy({ status: "ai", assigned_to: A })).toBeNull();
    expect(heldBy({ status: "closed", assigned_to: A })).toBeNull();
    expect(heldBy({ status: "human", assigned_to: null })).toBeNull();
  });

  it("first person can take an unassigned chat; the holder can keep replying", () => {
    expect(canTakeOver({ status: "needs_human", assigned_to: null }, A)).toEqual({ ok: true });
    expect(canTakeOver({ status: "human", assigned_to: A }, A)).toEqual({ ok: true });
  });

  it("a colleague is stopped unless they deliberately take it over", () => {
    expect(canTakeOver({ status: "human", assigned_to: A }, B)).toEqual({ ok: false, reason: "held_by_other", holder: A });
    expect(canTakeOver({ status: "human", assigned_to: A }, B, true)).toEqual({ ok: true });
  });

  it("names: display name, else email prefix", () => {
    expect(memberName(members, A)).toBe("Aisyah");
    expect(memberName(members, B)).toBe("bala");
    expect(memberName(members, "x")).toBeNull();
    expect(memberName(members, null)).toBeNull();
  });

});
