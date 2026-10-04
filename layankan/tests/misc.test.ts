import { describe, expect, it } from "vitest";
import { buildDigest, isSummaryDue, localParts } from "@/lib/notify/digest";
import { toCsv } from "@/lib/leads/query";
import { webAdapter, newVisitorToken, isValidVisitorToken, visitorExternalId } from "@/lib/channels/web";
import { brainFromRow } from "@/lib/brain/schema";
import { isPrivateAddress } from "@/lib/ssrf";

describe("daily summary scheduling", () => {
  it("uses the tenant's local time (default Asia/Kuala_Lumpur, UTC+8)", () => {
    const now = new Date("2026-10-04T00:30:00Z"); // 08:30 in KL
    expect(localParts(now, "Asia/Kuala_Lumpur")).toEqual({ date: "2026-10-04", hour: 8 });
    expect(isSummaryDue(now, "Asia/Kuala_Lumpur", 8).due).toBe(true);
    expect(isSummaryDue(now, "Asia/Kuala_Lumpur", 9).due).toBe(false);
    expect(isSummaryDue(now, "Europe/London", 8).due).toBe(false); // 01:30 in London
  });

  it("builds counts and spots empty enquiries", () => {
    const base = { status: "ai", lead_details: {}, score_reason: null, next_action: null };
    const d = buildDigest([
      { ...base, id: "1", lead_score: "PANAS", customer_message_count: 5, status: "needs_human" },
      { ...base, id: "2", lead_score: "SUAM", customer_message_count: 3 },
      { ...base, id: "3", lead_score: "SEJUK", customer_message_count: 1 },
      { ...base, id: "4", lead_score: null, customer_message_count: 1 },
    ]);
    expect(d.counts).toEqual({ PANAS: 1, SUAM: 1, SEJUK: 1, unscored: 1 });
    expect(d.needsYou).toBe(1);
    expect(d.emptyEnquiries).toBe(2);
    expect(d.panas.map((c) => c.id)).toEqual(["1"]);
  });
});

describe("CSV export", () => {
  it("escapes quotes/commas and neutralises spreadsheet formulas", () => {
    const csv = toCsv([["a", 'he said "hi", ok', "=HYPERLINK(\"x\")", null]]);
    expect(csv).toBe('﻿a,"he said ""hi"", ok","\'=HYPERLINK(""x"")",\r\n');
  });
});

describe("web adapter", () => {
  it("normalises a visitor message", async () => {
    const token = newVisitorToken();
    expect(isValidVisitorToken(token)).toBe(true);
    const [ev] = await webAdapter.receiveMessage({ headers: new Headers(), rawBody: JSON.stringify({ visitorToken: token, message: "  Hi, harga?  " }) }, null);
    expect(ev).toMatchObject({ kind: "message", body: "Hi, harga?", contactExternalId: visitorExternalId(token) });
    expect(visitorExternalId(token)).not.toContain(token); // raw token never stored
  });
  it("rejects bad input", async () => {
    await expect(webAdapter.receiveMessage({ headers: new Headers(), rawBody: "{" }, null)).rejects.toThrow();
    await expect(webAdapter.receiveMessage({ headers: new Headers(), rawBody: JSON.stringify({ visitorToken: "x", message: "hi" }) }, null)).rejects.toThrow();
    await expect(webAdapter.receiveMessage({ headers: new Headers(), rawBody: JSON.stringify({ visitorToken: newVisitorToken(), message: "   " }) }, null)).rejects.toThrow();
  });
});

describe("brain parsing", () => {
  it("fills defaults for partial / legacy rows instead of crashing", () => {
    const b = brainFromRow({ profile: { name: "X" }, products: null });
    expect(b.profile.tone).toBe("santai");
    expect(b.products).toEqual([]);
    expect(b.handoff_rules.ready_to_buy).toBe(true);
  });
});

describe("SSRF guard", () => {
  it("blocks private and loopback addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });
});
