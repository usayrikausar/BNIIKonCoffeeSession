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

describe("rate limiting (audit M3)", async () => {
  const { clientIp, allow, __test } = await import("@/lib/ratelimit");
  it("never trusts the visitor-supplied first X-Forwarded-For hop", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(new Headers({ "x-vercel-forwarded-for": "198.51.100.1", "x-forwarded-for": "6.6.6.6" }))).toBe("198.51.100.1");
    expect(clientIp(new Headers())).toBe("unknown");
  });
  it("falls back to an in-memory limit when the database limiter errors", async () => {
    __test.memory.clear();
    const broken = { rpc: async () => ({ data: null, error: { message: "db down" } }) } as never;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await allow(broken, "chat:test", 60, 3));
    expect(results).toEqual([true, true, true, false]);
  });
});

describe("schema guard: REST embeds stay unambiguous", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  it("no table references BOTH tenants and conversations/contacts in its primary key (would break `conversation + tenant` queries)", () => {
    // real migrations + the Stage 5 DRAFT data model (docs/design), so future tables follow the rule too
    const files = [
      ...readdirSync("supabase/migrations").sort().map((f) => `supabase/migrations/${f}`),
      ...readdirSync("docs/design").filter((f) => f.endsWith("_data_model.sql")).map((f) => `docs/design/${f}`),
    ];
    const sql = files.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const m of sql.matchAll(/create table public\.(\w+) \(([\s\S]*?)\n\);/g)) {
      const [, name, body] = m;
      const pk = /primary key \(([^)]*)\)/.exec(body!)?.[1] ?? "";
      const fkCols = [...body!.matchAll(/\n\s*(\w+) uuid[^,\n]*references public\.(\w+)/g)].filter(([, col]) => pk.includes(col!)).map(([, , t]) => t);
      const both = fkCols.includes("tenants") && fkCols.some((t) => t !== "tenants");
      expect(both, `${name} looks like a tenants↔${fkCols.join("/")} junction table`).toBe(false);
    }
  });
  it("the Stage 5 draft data model is NOT a migration (design only)", () => {
    expect(readdirSync("supabase/migrations").some((f) => /stage5|draft/i.test(f))).toBe(false);
    expect(readFileSync("docs/design/stage5_data_model.sql", "utf8")).toMatch(/DRAFT DATA MODEL — STAGE 5 DESIGN\. NOT A MIGRATION\. NOT APPLIED\./);
  });
});
