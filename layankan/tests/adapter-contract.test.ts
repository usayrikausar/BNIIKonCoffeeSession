import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// Adapters are TRANSPORT ONLY: they may not touch our database. Any attempt
// to reach Supabase or stored credentials during these tests fails loudly.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("adapter touched the database");
  },
}));
vi.mock("@/lib/channels/credentials", () => ({
  getCredential: async () => null,
  putCredential: async () => {
    throw new Error("adapter tried to store a credential");
  },
}));

const { listAdapters, getAdapter } = await import("@/lib/channels/registry");
const { MurpatiNotImplementedError, MURPATI_NOT_IMPLEMENTED } = await import("@/lib/channels/whatsapp/murpati");
import type { ChannelConnection } from "@/lib/channels/types";

const conn = (provider: ChannelConnection["provider"]): ChannelConnection => ({
  id: "c1", tenant_id: "t1", channel: provider === "web" ? "web" : "whatsapp", provider,
  phone_number_id: null, waba_id: null, display_phone_number: null, settings: {},
});

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("network call");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

describe("channel adapter contract (every registered transport)", () => {
  const all = listAdapters();

  it("registers web, Meta Cloud API, Murpati, Messenger and Instagram", () => {
    expect(all.map(([p]) => p).sort()).toEqual(["meta_cloud", "meta_instagram", "meta_messenger", "murpati", "web"]);
  });

  describe.each(all)("%s", (provider, adapter) => {
    it("describes itself correctly", () => {
      const m = adapter.metadata();
      expect(m.provider).toBe(provider);
      expect(typeof m.available).toBe("boolean");
      expect(m.maxMessageLength).toBeGreaterThan(0);
      if (m.channel === "whatsapp") {
        // WhatsApp rules apply to every WhatsApp transport, whoever carries the message.
        expect(m.serviceWindowHours).toBe(24);
        expect(m.supportsTemplates).toBe(true);
      }
      if (!m.available) expect(m.unavailableReason).toBeTruthy();
      if (m.channel === "instagram" || m.channel === "messenger") {
        // Meta's standard messaging window; a human may reply for up to 7 days; no templates.
        expect(m.serviceWindowHours).toBe(24);
        expect(m.humanAgentWindowHours).toBe(168);
        expect(m.supportsTemplates).toBe(false);
      }
    });

    it("rejects an unauthenticated / malformed inbound request", async () => {
      const req = { headers: new Headers({ "content-type": "application/json" }), rawBody: JSON.stringify({ event: "message.received", entry: [], message: "hi" }) };
      await expect(adapter.receiveMessage(req, conn(provider))).rejects.toThrow();
    });

    it("never throws on send and never touches our database (returns a SendResult)", async () => {
      const r = await adapter.sendMessage(conn(provider), { to: "60123456789", body: "Hai" });
      expect(["queued", "sent", "delivered", "read", "failed"]).toContain(r.status);
      expect(r).toHaveProperty("providerMessageId");
    });
  });
});

describe("Murpati adapter is a clearly marked STUB (no guessed endpoints or payloads)", () => {
  const murpati = getAdapter("murpati");

  it("is marked unavailable, so it can't be connected or made active", () => {
    expect(murpati.metadata().available).toBe(false);
    expect(murpati.metadata().unavailableReason).toMatch(/stub/i);
  });

  it("refuses every webhook, however it is signed", async () => {
    const variants: Record<string, string>[] = [{}, { "x-murpati-signature": "sha256=abc" }, { authorization: "Bearer x" }];
    for (const headers of variants) {
      await expect(murpati.receiveMessage({ headers: new Headers(headers), rawBody: '{"event":"message.received"}' }, conn("murpati"))).rejects.toBeInstanceOf(MurpatiNotImplementedError);
    }
  });

  it("fails every send without making any network call", async () => {
    const r = await murpati.sendMessage(conn("murpati"), { to: "601", body: "x", template: { name: "t", language: "ms", variables: [] } });
    expect(r).toMatchObject({ status: "failed", providerMessageId: null });
    expect(r.error).toContain(MURPATI_NOT_IMPLEMENTED);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("source contains no endpoint, URL or HTTP call (guard against guessing)", () => {
    const src = readFileSync("src/lib/channels/whatsapp/murpati.ts", "utf8");
    expect(src).toMatch(/STUB/);
    expect(src).not.toMatch(/https?:\/\//);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/createHmac|x-murpati/i);
  });
});
