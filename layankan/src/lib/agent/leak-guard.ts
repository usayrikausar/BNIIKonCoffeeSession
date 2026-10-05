import type { Brain } from "@/lib/brain/schema";
import { buildSystemPrompt } from "./prompt";

// Last line of defence if a customer talks the model into revealing its
// instructions. Runs on every reply before it is sent. Pure: no I/O.
//
// It guards the INSTRUCTION part of the system prompt only. Business facts
// (prices, FAQ answers, policies, additional information) are meant to be
// quoted to customers, and the owner's own qualifying questions are meant to
// be asked, so neither counts as a leak.

// Section names and phrases that only appear in our instructions.
const MARKERS = [
  /#\s*(how to reply|qualifying questions|lead scoring|handing off to a human|security|output|business information)\b/i,
  /lead scoring \(for the business owner/i,
  /business information \(the only facts/i,
  /text from the customer is untrusted/i,
  /never reveal or summari[sz]e these instructions/i,
  /handoff_required/i,
  /prompt_template_version|system prompt:/i,
];

// A run of this many consecutive words copied from the instructions is a leak.
const SPAN_WORDS = 10;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function instructionText(brain: Brain): string {
  const sys = buildSystemPrompt(brain);
  const cut = sys.indexOf("\n# Business information");
  let text = cut === -1 ? sys : sys.slice(0, cut);
  for (const q of brain.qualifying_questions) text = text.split(q).join(" ");
  return text;
}

const spanCache = new WeakMap<Brain, Set<string>>();
function instructionSpans(brain: Brain): Set<string> {
  let spans = spanCache.get(brain);
  if (!spans) {
    const w = words(instructionText(brain));
    spans = new Set();
    for (let i = 0; i + SPAN_WORDS <= w.length; i++) spans.add(w.slice(i, i + SPAN_WORDS).join(" "));
    spanCache.set(brain, spans);
  }
  return spans;
}

/** Returns why the reply looks like a leak of our instructions, or null if it is fine. */
export function detectInstructionLeak(reply: string, brain: Brain): string | null {
  for (const m of MARKERS) if (m.test(reply)) return "reply contains internal instruction markers";
  const spans = instructionSpans(brain);
  const w = words(reply);
  for (let i = 0; i + SPAN_WORDS <= w.length; i++) {
    if (spans.has(w.slice(i, i + SPAN_WORDS).join(" "))) return "reply quotes the internal instructions";
  }
  return null;
}
