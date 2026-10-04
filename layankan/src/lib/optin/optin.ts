// Marketing opt-in capture (R1). Pure: no I/O, unit tested.
//
// The question, and the reading of the answer, are done by CODE with fixed,
// versioned wording. The AI never decides whether someone consented.
//
// The customer agrees by replying with the keyword PROMO, not a bare "ya":
// the AI often asks its own yes/no questions ("Nak saya tempah Sabtu?"), and
// a "ya" to that must never be mistaken for marketing consent.

/** Bump whenever the wording below changes; stored with every consent record. */
export const OPTIN_TEXT_VERSION = "optin-2026-10-04.1";

/** How long a YES still counts as an answer to the question. */
export const OPTIN_ANSWER_WINDOW_HOURS = 72;

export type Lang = "ms" | "en";

export function optinQuestion(businessName: string, lang: Lang): string {
  const b = businessName.trim() || (lang === "ms" ? "kami" : "us");
  return lang === "ms"
    ? `📣 Sekali-sekala ${b} ada promosi & tawaran istimewa. Nak terima melalui WhatsApp? Balas PROMO untuk setuju. Tak perlu balas jika tidak mahu. (Boleh balas STOP bila-bila masa untuk berhenti.)`
    : `📣 Every now and then ${b} has promotions and special offers. Want them on WhatsApp? Reply PROMO to agree. No need to reply if not. (You can reply STOP at any time to stop.)`;
}

export function optinConfirmation(businessName: string, lang: Lang): string {
  const b = businessName.trim() || (lang === "ms" ? "kami" : "us");
  return lang === "ms"
    ? `Terima kasih! 🙏 Anda akan terima promosi daripada ${b} sekali-sekala. Balas STOP bila-bila masa untuk berhenti.`
    : `Thank you! 🙏 You'll get occasional promotions from ${b}. Reply STOP at any time to stop.`;
}

// Only a clear, whole-message PROMO counts ("promo", "ya promo", "PROMO!", "setuju promo").
// "ya", "ok", "promo apa?" and "ada promo tak?" do NOT count.
const AGREE = /^((ya|yes|ok|okay|setuju)\s+)?promo(\s+(ya|yes|please|setuju))?$/;

export function isOptinAgreement(body: string): boolean {
  const t = body
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, "") // emoji
    .replace(/[.!,~*_]+/g, " ") // punctuation and WhatsApp *bold* / _italic_
    .replace(/\s+/g, " ")
    .trim();
  return AGREE.test(t);
}

export interface AskContext {
  enabled: boolean;
  channel: string;
  isTest: boolean;
  optedOut: boolean;
  alreadyAsked: boolean;
  hasConsentRecord: boolean;
  handoff: boolean;
  score: string | null;
  customerMessages: number;
  bookingOfferedThisTurn: boolean;
}

/**
 * Ask once, at a natural moment: an engaged WhatsApp chat (2+ customer
 * messages) with a SUAM or PANAS lead, not while handing off, and not in the
 * same message as the booking link. Never to opted-out customers, and never in tests.
 */
export function shouldAskOptin(c: AskContext): boolean {
  return (
    c.enabled &&
    c.channel === "whatsapp" && // broadcasts go over WhatsApp: consent must be tied to that number
    !c.isTest &&
    !c.optedOut &&
    !c.alreadyAsked &&
    !c.hasConsentRecord &&
    !c.handoff &&
    (c.score === "SUAM" || c.score === "PANAS") &&
    c.customerMessages >= 2 &&
    !c.bookingOfferedThisTurn
  );
}

/** Is a reply arriving now still an answer to a question asked at `askedAt`? */
export function withinAnswerWindow(askedAt: string | null, now: Date = new Date()): boolean {
  if (!askedAt) return false;
  const t = Date.parse(askedAt);
  return Number.isFinite(t) && now.getTime() - t >= 0 && now.getTime() - t <= OPTIN_ANSWER_WINDOW_HOURS * 3600 * 1000;
}
