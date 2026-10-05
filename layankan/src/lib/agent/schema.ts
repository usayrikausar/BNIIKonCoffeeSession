import { z } from "zod";

export const LEAD_SCORES = ["PANAS", "SUAM", "SEJUK"] as const;
export type LeadScore = (typeof LEAD_SCORES)[number];

/**
 * Shape the model must return for EVERY customer message (structured output).
 * Kept to JSON-Schema features supported by structured outputs: no numeric
 * ranges here — range checks happen in `validateAgentOutput` below.
 */
export const AgentOutputSchema = z.object({
  reply: z.string().describe("The message to send to the customer. Short, WhatsApp style, in the customer's language."),
  language: z.enum(["ms", "en", "mixed"]).describe("Language of the customer's latest message."),
  assessment: z.object({
    score: z.enum(LEAD_SCORES).describe("PANAS = ready to buy soon; SUAM = interested, needs follow-up; SEJUK = browsing / empty enquiry."),
    confidence: z.number().describe("0 to 1: how confident you are in this score."),
    reason: z.string().describe("One short sentence for the business owner: WHY this score, citing what the customer said."),
    captured: z.object({
      name: z.string().nullable(),
      need: z.string().nullable(),
      timeline: z.string().nullable(),
      budget: z.string().nullable(),
      phone: z.string().nullable(),
      email: z.string().nullable(),
    }),
    next_action: z.string().describe("What the business owner (or the AI) should do next."),
    handoff_required: z.boolean(),
    handoff_reason: z.string().nullable(),
    signals: z.object({
      ready_to_buy: z.boolean(),
      complaint: z.boolean(),
      asked_for_human: z.boolean(),
      unsure: z.boolean().describe("True if the answer is not in the business information."),
      empty_enquiry: z.boolean().describe("True if the customer has shared nothing beyond a bare greeting or 'harga?'."),
    }),
  }),
  memory_updates: z
    .array(
      z.object({
        kind: z.enum(["preference", "fact"]),
        content: z.string().describe("One short durable fact the CUSTOMER stated about themselves, e.g. 'Prefers Saturday morning slots'."),
      }),
    )
    .describe("New things worth remembering about this customer for next time. Usually empty. Never health, religion, IC/passport, bank or card details, prices, discounts or promises."),
});

export type AgentOutput = z.infer<typeof AgentOutputSchema>;
export type Assessment = AgentOutput["assessment"];

const MAX_REPLY_CHARS = 1200;

/**
 * Second line of defence after structured output: enforce ranges and limits
 * the JSON schema can't express, and normalise values. Throws on anything that
 * cannot be safely repaired so the engine falls back to a human handoff.
 */
export function validateAgentOutput(raw: unknown): AgentOutput {
  const parsed = AgentOutputSchema.parse(raw);
  const a = parsed.assessment;
  if (!Number.isFinite(a.confidence)) throw new Error("confidence is not a number");
  const reply = parsed.reply.trim();
  if (!reply) throw new Error("empty reply");
  const clean = (s: string | null) => (s && s.trim() ? s.trim().slice(0, 300) : null);
  return {
    reply: reply.length > MAX_REPLY_CHARS ? reply.slice(0, MAX_REPLY_CHARS).trimEnd() + "…" : reply,
    language: parsed.language,
    // At most 3 per turn, trimmed; the memory filter (src/lib/memory) decides what is actually kept.
    memory_updates: (parsed.memory_updates ?? []).slice(0, 3).map((m) => ({ kind: m.kind, content: m.content.replace(/\s+/g, " ").trim().slice(0, 300) })).filter((m) => m.content),
    assessment: {
      ...a,
      confidence: Math.min(1, Math.max(0, a.confidence)),
      reason: a.reason.trim().slice(0, 500),
      next_action: a.next_action.trim().slice(0, 500),
      handoff_reason: clean(a.handoff_reason),
      captured: {
        name: clean(a.captured.name),
        need: clean(a.captured.need),
        timeline: clean(a.captured.timeline),
        budget: clean(a.captured.budget),
        phone: clean(a.captured.phone),
        email: clean(a.captured.email),
      },
    },
  };
}

/** Merge newly captured details into what we already know (never erase with null). */
export function mergeLeadDetails(
  existing: Record<string, string | null | undefined>,
  captured: Assessment["captured"],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(existing ?? {})) if (typeof v === "string" && v) out[k] = v;
  for (const [k, v] of Object.entries(captured)) if (v) out[k] = v;
  return out;
}

export const SCORE_RANK: Record<LeadScore, number> = { PANAS: 0, SUAM: 1, SEJUK: 2 };
