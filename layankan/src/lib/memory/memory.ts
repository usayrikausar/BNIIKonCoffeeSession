// Customer memory (R3). Pure rules — no I/O, unit tested.
//
// The AI may PROPOSE memories; this filter decides what is kept. Memories are
// later shown to the AI as data (never instructions), so anything that could
// act as a price, discount, promise or instruction is refused here too.

export type MemoryKind = "preference" | "fact" | "purchase" | "note";
export interface Proposal {
  kind: "preference" | "fact";
  content: string;
}
export type RejectReason = "sensitive" | "commercial_or_instruction" | "too_short" | "duplicate" | "clinic_preferences_only" | "too_many";

export const MAX_MEMORIES_PER_TURN = 3;
export const MEMORY_RETENTION_MONTHS = 12;

// PDPA "sensitive personal data" (health, religion, politics, offences) plus
// identity/financial numbers. BM, English and common Manglish spellings.
const SENSITIVE: RegExp[] = [
  /\b(sakit|penyakit|demam|diabetes|kencing\s*manis|darah\s*tinggi|tekanan\s*darah|asma|asthma|kanser|cancer|hiv|aids|strok|stroke|jantung|heart\s*(disease|problem|condition)|mengandung|hamil|pregnan|ubat|medication|medicine|surgery|pembedahan|alergi|allerg|depress|kemurungan|anxiety|mental|diagnos|rawatan\s+untuk|treatment\s+for|medical\s*condition|kidney|buah\s*pinggang|pesakit|patient)\w*/i,
  /\b(agama|religion|religious|islam|muslim|kristian|christian|buddh|hindu|sikh|atheis|atheist|gereja|church|masjid|mosque|kuil|temple)\w*/i,
  /\b(politik|politic|parti|party\s+member|undi|vote[ds]?\s+for)\w*/i,
  /\b(jenayah|criminal|penjara|prison|jail|ditangkap|arrested|dadah|drug\s+use)\w*/i,
  /\b(bangsa|race|ethnic|kaum)\b/i,
  /\b(ic|mykad|nric|passport|pasport|kad\s*pengenalan)\b/i,
  /\b\d{6}-?\d{2}-?\d{4}\b/, // Malaysian IC number
  /\b(bank|akaun\s*bank|account\s*(no|number)|card\s*(no|number)|kad\s*kredit|credit\s*card|debit|cvv|pin|password|kata\s*laluan|otp)\b/i,
  /\b\d{9,19}\b/, // long digit runs: account / card numbers
];

// Anything that could later be read as a business fact, price, offer or instruction.
const COMMERCIAL_OR_INSTRUCTION: RegExp[] = [
  /\brm\s?\d/i, // any ringgit amount
  /\d\s?%/, // any percentage
  /\b(percuma|free|diskaun|discount|potongan|harga|price|promo|tawaran|offer|baucar|voucher|refund|bayaran\s+balik)\b/i,
  /\b(janji|promise[ds]?|dijanjikan|guarantee|jamin|owner\s+(said|agreed)|tuan\s+punya|boss\s+(said|cakap))\b/i,
  /\b(ignore|abaikan|instruction|arahan|system|prompt|you\s+(are|must|should)|awak\s+(mesti|kena)|assistant|developer)\b/i,
];

const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function isSensitiveMemory(text: string): boolean {
  return SENSITIVE.some((r) => r.test(text));
}

export function isCommercialOrInstruction(text: string): boolean {
  return COMMERCIAL_OR_INSTRUCTION.some((r) => r.test(text));
}

/**
 * Decide which AI proposals to keep. Clinics (industry "klinik") keep only
 * preferences (e.g. preferred day/branch/doctor gender), never "facts".
 */
export function filterProposals(
  proposals: Proposal[],
  ctx: { industry: string; existing: string[] },
): { keep: Proposal[]; rejected: { content: string; reason: RejectReason }[] } {
  const keep: Proposal[] = [];
  const rejected: { content: string; reason: RejectReason }[] = [];
  const seen = new Set(ctx.existing.map(norm));
  for (const p of proposals) {
    const content = p.content.replace(/\s+/g, " ").trim().slice(0, 300);
    let reason: RejectReason | null = null;
    if (keep.length >= MAX_MEMORIES_PER_TURN) reason = "too_many";
    else if (content.length < 4) reason = "too_short";
    else if (isSensitiveMemory(content)) reason = "sensitive";
    else if (isCommercialOrInstruction(content)) reason = "commercial_or_instruction";
    else if (ctx.industry === "klinik" && p.kind !== "preference") reason = "clinic_preferences_only";
    else if (seen.has(norm(content))) reason = "duplicate";
    if (reason) rejected.push({ content, reason });
    else {
      keep.push({ kind: p.kind, content });
      seen.add(norm(content));
    }
  }
  return { keep, rejected };
}

/** Staff notes: the same sensitive-data rule applies (staff see a clear error instead). */
export function validateStaffNote(text: unknown): { content: string } | { error: string } {
  const content = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (content.length < 2 || content.length > 300) return { error: "Nota 2–300 aksara / Note must be 2–300 characters" };
  if (isSensitiveMemory(content)) {
    return { error: "Jangan simpan data sensitif (kesihatan, agama, IC, nombor akaun/kad, kata laluan) / Don't store sensitive data (health, religion, IC, account/card numbers, passwords)" };
  }
  return { content };
}

export function purchaseMemory(description: string, paidCents: number, paidAt: Date, timeZone = "Asia/Kuala_Lumpur"): string {
  const d = paidAt.toLocaleDateString("ms-MY", { day: "numeric", month: "short", year: "numeric", timeZone });
  return `Membeli: ${description} (RM${(paidCents / 100).toFixed(2)}) pada ${d}`.slice(0, 300);
}
