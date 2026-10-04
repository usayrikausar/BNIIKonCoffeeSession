import { z } from "zod";

// The Business Brain is the ONLY source of tenant-specific behaviour.
// Everything here is plain data that owners edit; the agent prompt is assembled
// from it by a versioned template (src/lib/agent/prompt.ts).

const text = (max: number) => z.string().trim().max(max);

export const ProfileSchema = z.object({
  name: text(120).default(""),
  industry: text(40).default("umum"),
  description: text(1500).default(""),
  location: text(300).default(""),
  operating_hours: text(300).default(""),
  tone: z.enum(["formal", "santai"]).default("santai"),
  languages: z.array(z.enum(["ms", "en"])).min(1).default(["ms", "en"]),
});

export const ProductSchema = z.object({
  name: text(120),
  description: text(1000).default(""),
  price: text(120).default(""),
  suits: text(500).default(""),
});

export const FaqSchema = z.object({ q: text(300), a: text(1500) });

export const PoliciesSchema = z.object({
  booking: text(1500).default(""),
  payment: text(1500).default(""),
  delivery: text(1500).default(""),
  refunds: text(1500).default(""),
  other: text(1500).default(""),
});

export const HandoffRulesSchema = z.object({
  ready_to_buy: z.boolean().default(true),
  complaint: z.boolean().default(true),
  ai_unsure: z.boolean().default(true),
  asked_for_human: z.boolean().default(true),
  owner_whatsapp: z
    .string()
    .trim()
    .regex(/^(\+?\d[\d\s-]{6,18})?$/, "Nombor WhatsApp tidak sah")
    .default(""),
  min_confidence: z.number().min(0).max(1).default(0.5),
});

export const BrainSchema = z.object({
  profile: ProfileSchema.default(ProfileSchema.parse({})),
  products: z.array(ProductSchema).max(100).default([]),
  faqs: z.array(FaqSchema).max(200).default([]),
  policies: PoliciesSchema.default(PoliciesSchema.parse({})),
  qualifying_questions: z.array(text(300).min(1)).max(4).default([]),
  handoff_rules: HandoffRulesSchema.default(HandoffRulesSchema.parse({})),
  extra_knowledge: text(20000).default(""),
});

export type Brain = z.infer<typeof BrainSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type Faq = z.infer<typeof FaqSchema>;

/** Parse a DB row leniently (fills defaults) so old/partial rows never crash the agent. */
export function brainFromRow(row: Record<string, unknown> | null | undefined): Brain {
  const r = row ?? {};
  const parsed = BrainSchema.safeParse({
    profile: r.profile ?? {},
    products: r.products ?? [],
    faqs: r.faqs ?? [],
    policies: r.policies ?? {},
    qualifying_questions: r.qualifying_questions ?? [],
    handoff_rules: r.handoff_rules ?? {},
    extra_knowledge: r.extra_knowledge ?? "",
  });
  return parsed.success ? parsed.data : BrainSchema.parse({});
}

export const INDUSTRIES = [
  "klinik",
  "kecantikan",
  "hartanah",
  "pendidikan",
  "makanan",
  "servis",
  "automotif",
  "runcit",
  "pelancongan",
  "saas",
  "umum",
] as const;
export type Industry = (typeof INDUSTRIES)[number];

export const INDUSTRY_LABELS: Record<Industry, { ms: string; en: string }> = {
  klinik: { ms: "Klinik / Kesihatan", en: "Clinic / Health" },
  kecantikan: { ms: "Salun / Kecantikan / Spa", en: "Salon / Beauty / Spa" },
  hartanah: { ms: "Hartanah", en: "Property" },
  pendidikan: { ms: "Pendidikan / Kursus / Tuisyen", en: "Education / Courses / Tuition" },
  makanan: { ms: "F&B / Katering / Kek", en: "F&B / Catering / Bakery" },
  servis: { ms: "Servis Rumah (aircond, plumbing, cuci)", en: "Home services" },
  automotif: { ms: "Automotif / Bengkel / Sewa kereta", en: "Automotive / Workshop / Car rental" },
  runcit: { ms: "Kedai / Jualan Online", en: "Retail / Online shop" },
  pelancongan: { ms: "Pelancongan / Homestay / Umrah", en: "Travel / Homestay / Umrah" },
  saas: { ms: "Perisian / Agensi", en: "Software / Agency" },
  umum: { ms: "Lain-lain", en: "Other" },
};

/** Sensible starting qualifying questions per industry (owner can edit). */
export const DEFAULT_QUALIFYING_QUESTIONS: Record<Industry, string[]> = {
  klinik: [
    "Rawatan atau perkhidmatan apa yang anda perlukan?",
    "Untuk siapa — diri sendiri, anak atau ahli keluarga?",
    "Bila anda mahu datang — hari ini, minggu ini, atau belum pasti?",
  ],
  kecantikan: [
    "Servis apa yang anda minat?",
    "Pernah buat servis ini sebelum ini?",
    "Tarikh dan masa yang sesuai untuk temujanji?",
  ],
  hartanah: [
    "Nak beli atau sewa? Untuk duduk sendiri atau pelaburan?",
    "Kawasan dan bajet anggaran?",
    "Dah ada kelulusan pinjaman, atau perlu bantuan?",
    "Bila anda rancang nak pindah / beli?",
  ],
  pendidikan: [
    "Kursus/kelas ini untuk siapa, dan umur atau tahap berapa?",
    "Matlamat utama — lulus peperiksaan, kemahiran kerja, atau minat?",
    "Bila mahu mula, dan lebih suka kelas online atau fizikal?",
  ],
  makanan: [
    "Untuk majlis apa, dan berapa orang (pax)?",
    "Tarikh dan lokasi majlis?",
    "Ada bajet anggaran per pax atau keseluruhan?",
  ],
  servis: [
    "Masalah atau servis apa yang diperlukan?",
    "Lokasi rumah/premis anda (kawasan)?",
    "Bila anda perlukan servis — segera atau boleh dijadualkan?",
  ],
  automotif: [
    "Model dan tahun kenderaan?",
    "Servis/masalah apa yang diperlukan (atau tarikh sewa)?",
    "Bila anda perlukan?",
  ],
  runcit: [
    "Produk atau variasi apa yang anda cari?",
    "Kuantiti yang diperlukan?",
    "Penghantaran ke kawasan mana, dan bila perlu sampai?",
  ],
  pelancongan: [
    "Destinasi dan tarikh perjalanan?",
    "Berapa orang dewasa dan kanak-kanak?",
    "Ada bajet anggaran?",
  ],
  saas: [
    "Perniagaan anda jenis apa?",
    "Berapa banyak pertanyaan pelanggan sehari?",
    "Siapa yang jawab pertanyaan sekarang?",
    "Bila anda perlukan penyelesaian ini?",
  ],
  umum: [
    "Apa yang anda perlukan?",
    "Bila anda perlukan?",
    "Ada bajet anggaran?",
  ],
};

export function isIndustry(v: string): v is Industry {
  return (INDUSTRIES as readonly string[]).includes(v);
}
