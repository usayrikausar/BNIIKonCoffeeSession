"use client";
import { useState } from "react";
import Link from "next/link";
import { dict, type Lang } from "@/lib/i18n";
import { DEFAULT_QUALIFYING_QUESTIONS, INDUSTRIES, INDUSTRY_LABELS, isIndustry, type Brain } from "@/lib/brain/schema";
import type { BrainDraft } from "@/lib/brain/extract";
import { saveBrain } from "./actions";
import { optinQuestion } from "@/lib/optin/optin";

interface TemplateOpt { name: string; language: string; body_text: string; variable_count: number }

export default function BrainEditor({ lang, initial, version, welcome, templates, businessName = "", optedIn = 0 }: {
  lang: Lang; initial: Brain; version: number; welcome: boolean; templates: TemplateOpt[]; businessName?: string; optedIn?: number;
}) {
  const t = dict(lang);
  const [b, setB] = useState<Brain>(initial);
  const [ver, setVer] = useState(version);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);

  const set = <K extends keyof Brain>(k: K, v: Brain[K]) => {
    setB((x) => ({ ...x, [k]: v }));
    setState("idle");
  };
  const setProfile = (k: keyof Brain["profile"], v: unknown) => set("profile", { ...b.profile, [k]: v });
  const setPolicy = (k: keyof Brain["policies"], v: string) => set("policies", { ...b.policies, [k]: v });
  const setRule = (k: keyof Brain["handoff_rules"], v: unknown) => set("handoff_rules", { ...b.handoff_rules, [k]: v });
  const setFollow = (k: keyof Brain["follow_up"], v: unknown) => {
    setB((x) => ({ ...x, follow_up: { ...x.follow_up, [k]: v } }));
    setState("idle");
  };

  async function save() {
    setState("saving");
    setErr(null);
    const res = await saveBrain(b);
    if (res.ok) {
      setState("saved");
      if (res.version) setVer(res.version);
    } else {
      setState("error");
      setErr(res.error ?? t("common.error"));
    }
  }

  function move<T>(arr: T[], i: number, d: -1 | 1): T[] {
    const j = i + d;
    if (j < 0 || j >= arr.length) return arr;
    const c = [...arr];
    [c[i], c[j]] = [c[j]!, c[i]!];
    return c;
  }

  function mergeDraft(d: BrainDraft) {
    setB((x) => ({
      ...x,
      profile: {
        ...x.profile,
        name: x.profile.name || d.profile.name || "",
        description: x.profile.description || d.profile.description || "",
        location: x.profile.location || d.profile.location || "",
        operating_hours: x.profile.operating_hours || d.profile.operating_hours || "",
      },
      products: [...x.products, ...d.products.filter((p) => p.name)],
      faqs: [...x.faqs, ...d.faqs.filter((f) => f.q && f.a)],
      policies: {
        booking: x.policies.booking || d.policies.booking || "",
        payment: x.policies.payment || d.policies.payment || "",
        delivery: x.policies.delivery || d.policies.delivery || "",
        refunds: x.policies.refunds || d.policies.refunds || "",
        other: x.policies.other || d.policies.other || "",
      },
      extra_knowledge: [x.extra_knowledge, d.extra_knowledge ?? ""].filter(Boolean).join("\n\n"),
    }));
    setState("idle");
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-24">
      <div>
        <h1 className="text-2xl font-bold">{t("brain.title")}</h1>
        <p className="text-sm text-zinc-500">{t("brain.intro")} <span className="text-zinc-400">(v{ver})</span></p>
      </div>
      {welcome && (
        <div className="rounded-xl bg-brand-50 p-4 text-sm text-brand-900">
          👋 {lang === "ms" ? "Ruang kerja dicipta! Isi maklumat di bawah (atau import dari PDF/laman web), Simpan, kemudian" : "Workspace created! Fill in the details below (or import from a PDF/website), Save, then"}{" "}
          <Link href="/dashboard/test" className="font-semibold underline">{t("nav.test")}</Link>.
        </div>
      )}

      <ImportPanel lang={lang} onMerge={mergeDraft} />

      <section className="card space-y-4">
        <h2 className="text-lg font-semibold">{t("brain.profile")}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("brain.name")}><input className="input" value={b.profile.name} onChange={(e) => setProfile("name", e.target.value)} /></Field>
          <Field label={t("brain.industry")}>
            <select className="input" value={b.profile.industry} onChange={(e) => setProfile("industry", e.target.value)}>
              {INDUSTRIES.map((i) => <option key={i} value={i}>{INDUSTRY_LABELS[i][lang]}</option>)}
            </select>
          </Field>
        </div>
        <Field label={t("brain.description")}><textarea className="input" rows={3} value={b.profile.description} onChange={(e) => setProfile("description", e.target.value)} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("brain.location")}><input className="input" value={b.profile.location} onChange={(e) => setProfile("location", e.target.value)} /></Field>
          <Field label={t("brain.hours")}><input className="input" value={b.profile.operating_hours} placeholder="Isnin–Sabtu 9am–6pm" onChange={(e) => setProfile("operating_hours", e.target.value)} /></Field>
        </div>
        <div className="flex flex-wrap gap-6">
          <Field label={t("brain.tone")}>
            <div className="flex gap-3 text-sm">
              {(["santai", "formal"] as const).map((v) => (
                <label key={v} className="flex items-center gap-1"><input type="radio" checked={b.profile.tone === v} onChange={() => setProfile("tone", v)} /> {t(`brain.tone.${v}`)}</label>
              ))}
            </div>
          </Field>
          <Field label={t("brain.languages")}>
            <div className="flex gap-3 text-sm">
              {(["ms", "en"] as const).map((l) => (
                <label key={l} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={b.profile.languages.includes(l)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...new Set([...b.profile.languages, l])] : b.profile.languages.filter((x) => x !== l);
                      if (next.length) setProfile("languages", next);
                    }}
                  />
                  {l === "ms" ? "Bahasa Malaysia" : "English"}
                </label>
              ))}
            </div>
          </Field>
        </div>
      </section>

      <section className="card space-y-4">
        <h2 className="text-lg font-semibold">{t("brain.products")}</h2>
        {b.products.map((p, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-zinc-200 p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <input className="input" placeholder={t("brain.product.name")} value={p.name} onChange={(e) => set("products", b.products.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input className="input" placeholder={t("brain.product.price")} value={p.price} onChange={(e) => set("products", b.products.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
            </div>
            <textarea className="input" rows={2} placeholder={t("brain.product.description")} value={p.description} onChange={(e) => set("products", b.products.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
            <input className="input" placeholder={t("brain.product.suits")} value={p.suits} onChange={(e) => set("products", b.products.map((x, j) => (j === i ? { ...x, suits: e.target.value } : x)))} />
            <RowTools onUp={() => set("products", move(b.products, i, -1))} onDown={() => set("products", move(b.products, i, 1))} onDelete={() => set("products", b.products.filter((_, j) => j !== i))} />
          </div>
        ))}
        <button className="btn-secondary" onClick={() => set("products", [...b.products, { name: "", description: "", price: "", suits: "" }])}>+ {t("common.add")}</button>
      </section>

      <section className="card space-y-4">
        <h2 className="text-lg font-semibold">{t("brain.faqs")}</h2>
        {b.faqs.map((f, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-zinc-200 p-3">
            <input className="input font-medium" placeholder={t("brain.faq.q")} value={f.q} onChange={(e) => set("faqs", b.faqs.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)))} />
            <textarea className="input" rows={2} placeholder={t("brain.faq.a")} value={f.a} onChange={(e) => set("faqs", b.faqs.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)))} />
            <RowTools onUp={() => set("faqs", move(b.faqs, i, -1))} onDown={() => set("faqs", move(b.faqs, i, 1))} onDelete={() => set("faqs", b.faqs.filter((_, j) => j !== i))} />
          </div>
        ))}
        <button className="btn-secondary" onClick={() => set("faqs", [...b.faqs, { q: "", a: "" }])}>+ {t("common.add")}</button>
      </section>

      <section className="card space-y-4">
        <h2 className="text-lg font-semibold">{t("brain.policies")}</h2>
        {(["booking", "payment", "delivery", "refunds", "other"] as const).map((k) => (
          <Field key={k} label={t(`brain.policy.${k}`)}><textarea className="input" rows={2} value={b.policies[k]} onChange={(e) => setPolicy(k, e.target.value)} /></Field>
        ))}
      </section>

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">{t("brain.qualifying")}</h2>
        <p className="text-sm text-zinc-500">{t("brain.qualifying.help")}</p>
        {b.qualifying_questions.map((q, i) => (
          <div key={i} className="flex gap-2">
            <input className="input" value={q} onChange={(e) => set("qualifying_questions", b.qualifying_questions.map((x, j) => (j === i ? e.target.value : x)))} />
            <button className="btn-secondary px-2" onClick={() => set("qualifying_questions", b.qualifying_questions.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          {b.qualifying_questions.length < 4 && <button className="btn-secondary" onClick={() => set("qualifying_questions", [...b.qualifying_questions, ""])}>+ {t("common.add")}</button>}
          <button
            className="btn-secondary"
            onClick={() => set("qualifying_questions", DEFAULT_QUALIFYING_QUESTIONS[isIndustry(b.profile.industry) ? b.profile.industry : "umum"])}
          >
            {t("brain.qualifying.reset")}
          </button>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">{t("brain.handoff")}</h2>
        {(["ready_to_buy", "complaint", "ai_unsure", "asked_for_human"] as const).map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={b.handoff_rules[k]} onChange={(e) => setRule(k, e.target.checked)} /> {t(`brain.handoff.${k}`)}
          </label>
        ))}
        <Field label={t("brain.handoff.whatsapp")}>
          <input className="input" placeholder="+60123456789" value={b.handoff_rules.owner_whatsapp} onChange={(e) => setRule("owner_whatsapp", e.target.value)} />
        </Field>
      </section>

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">{lang === "ms" ? "Pautan tempahan (untuk prospek PANAS)" : "Booking link (for PANAS leads)"}</h2>
        <p className="text-sm text-zinc-500">
          {lang === "ms"
            ? "Bila pelanggan sedia untuk tempah/beli (PANAS), AI akan hantar pautan ini sekali dalam chat. Contoh: Calendly, Google Form, halaman tempahan, atau wa.me nombor kaunter."
            : "When a customer is ready to book/buy (PANAS), the AI sends this link once in the chat. E.g. Calendly, Google Form, your booking page, or a wa.me counter number."}
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Field label={lang === "ms" ? "Pautan (https://…)" : "Link (https://…)"}>
              <input className="input" inputMode="url" placeholder="https://calendly.com/klinik-ana" value={b.booking.url} onChange={(e) => set("booking", { ...b.booking, url: e.target.value.trim() })} />
            </Field>
          </div>
          <Field label={lang === "ms" ? "Label (pilihan)" : "Label (optional)"}>
            <input className="input" placeholder={lang === "ms" ? "Borang tempahan" : "Booking form"} value={b.booking.label} onChange={(e) => set("booking", { ...b.booking, label: e.target.value })} />
          </Field>
        </div>
        {b.booking.url && !/^https:\/\/\S+$/i.test(b.booking.url) && (
          <p className="text-xs text-red-600">{lang === "ms" ? "Pautan mesti bermula dengan https://" : "The link must start with https://"}</p>
        )}
      </section>

      <FollowUpSection lang={lang} f={b.follow_up} setFollow={setFollow} templates={templates} />

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">{lang === "ms" ? "Ingat pelanggan yang kembali" : "Remember returning customers"}</h2>
        <p className="text-sm text-zinc-500">
          {lang === "ms"
            ? "AI akan ingat perkara ringkas yang pelanggan kongsi (cth. hari pilihan, cawangan), dan pembelian yang telah dibayar, supaya pelanggan yang kembali tidak perlu mengulang. Staf boleh lihat, tambah dan buang dalam setiap chat. Disimpan 12 bulan. AI TIDAK akan simpan maklumat kesihatan, agama, IC, nombor akaun/kad, harga atau janji."
            : "The AI remembers short things customers share (e.g. preferred day, branch) and paid purchases, so returning customers don't have to repeat themselves. Staff can see, add and remove them in each chat. Kept for 12 months. The AI will NOT store health, religion, IC, account/card numbers, prices or promises."}
        </p>
        {b.profile.industry === "klinik" && (
          <p className="rounded bg-amber-50 p-2 text-xs text-amber-900">
            {lang === "ms" ? "Klinik: AI hanya simpan pilihan temujanji (cth. hari, doktor, cawangan), tidak pernah butiran perubatan." : "Clinics: the AI only stores appointment preferences (e.g. day, doctor, branch), never medical details."}
          </p>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={b.memory.enabled} onChange={(e) => set("memory", { ...b.memory, enabled: e.target.checked })} />
          {lang === "ms" ? "Ingat pelanggan" : "Remember customers"}
        </label>
      </section>

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">{lang === "ms" ? "Promosi: minta kebenaran pelanggan (WhatsApp)" : "Promotions: ask customers for permission (WhatsApp)"}</h2>
        <p className="text-sm text-zinc-500">
          {lang === "ms"
            ? "AI akan bertanya SEKALI kepada setiap pelanggan WhatsApp yang berminat (SUAM/PANAS) sama ada mereka mahu terima promosi. Hanya pelanggan yang membalas PROMO direkodkan sebagai setuju, bersama bukti (ayat tepat dan balasan mereka). Mereka boleh balas STOP bila-bila masa. Siaran promosi akan datang kemudian dan hanya kepada pelanggan yang setuju."
            : "The AI asks each interested WhatsApp customer (SUAM/PANAS) ONCE whether they'd like promotions. Only customers who reply PROMO are recorded as agreeing, with proof (the exact wording and their reply). They can reply STOP at any time. Promotional broadcasts come later, and only to customers who agreed."}
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={b.promotions.ask_optin} onChange={(e) => set("promotions", { ...b.promotions, ask_optin: e.target.checked })} />
          {lang === "ms" ? "Tanya pelanggan sama ada mereka mahu terima promosi" : "Ask customers if they'd like promotions"}
        </label>
        <div className="rounded-lg bg-zinc-50 p-3 text-sm">
          <div className="mb-1 text-xs font-semibold text-zinc-500">{lang === "ms" ? "Mesej yang akan dihantar (tepat):" : "Message that will be sent (exact):"}</div>
          <p className="whitespace-pre-wrap text-zinc-700">{optinQuestion(b.profile.name || businessName, lang === "ms" ? "ms" : "en")}</p>
        </div>
        <p className="text-sm">
          <b>{optedIn}</b> {lang === "ms" ? "pelanggan telah setuju terima promosi." : optedIn === 1 ? "customer has agreed to receive promotions." : "customers have agreed to receive promotions."}
        </p>
      </section>

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">{t("brain.extra")}</h2>
        <textarea className="input" rows={6} value={b.extra_knowledge} onChange={(e) => set("extra_knowledge", e.target.value)} />
      </section>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-zinc-200 bg-white/95 p-3 backdrop-blur md:left-60">
        <div className="mx-auto flex max-w-3xl items-center justify-end gap-3">
          {err && <span className="text-sm text-red-600">{err}</span>}
          {state === "saved" && <Link href="/dashboard/test" className="text-sm font-semibold text-brand-700">{t("nav.test")} →</Link>}
          <button onClick={save} disabled={state === "saving"} className="btn-primary">
            {state === "saving" ? t("common.saving") : state === "saved" ? t("common.saved") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

function FollowUpSection({ lang, f, setFollow, templates }: {
  lang: Lang;
  f: Brain["follow_up"];
  setFollow: (k: keyof Brain["follow_up"], v: unknown) => void;
  templates: TemplateOpt[];
}) {
  const ms = lang === "ms";
  const selected = templates.find((x) => x.name === f.template_name && x.language === f.template_language);
  return (
    <section className="card space-y-3">
      <h2 className="text-lg font-semibold">{ms ? "Susulan Prospek SUAM (WhatsApp)" : "SUAM lead follow-ups (WhatsApp)"}</h2>
      <p className="text-sm text-zinc-500">
        {ms
          ? "AI akan menghantar sehingga 2 mesej susulan kepada prospek SUAM yang senyap. Hanya antara 9 pagi–9 malam, tidak kepada pelanggan yang menulis STOP / BERHENTI, dan boleh dimatikan untuk chat tertentu dalam Peti Masuk."
          : "The AI sends up to 2 nudges to SUAM leads who went quiet. Only 9am–9pm, never to customers who replied STOP / BERHENTI, and it can be switched off for any single chat in the Inbox."}
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={f.enabled} onChange={(e) => setFollow("enabled", e.target.checked)} /> {ms ? "Aktifkan susulan" : "Enable follow-ups"}
      </label>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={ms ? "Bilangan susulan" : "Number of follow-ups"}>
          <select className="input" value={Math.min(f.max_attempts, 2)} onChange={(e) => setFollow("max_attempts", Number(e.target.value))}>
            {[1, 2].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field label={ms ? "Susulan 1: selepas senyap (jam)" : "Follow-up 1: after silence (hours)"}>
          <input type="number" min={1} max={168} className="input" value={f.delay_hours} onChange={(e) => setFollow("delay_hours", Math.max(1, Math.min(168, Number(e.target.value) || 24)))} />
        </Field>
        {f.max_attempts >= 2 && (
          <Field label={ms ? "Susulan 2: selepas susulan 1 (jam)" : "Follow-up 2: after follow-up 1 (hours)"}>
            <input type="number" min={1} max={336} className="input" value={f.second_delay_hours} onChange={(e) => setFollow("second_delay_hours", Math.max(1, Math.min(336, Number(e.target.value) || 72)))} />
          </Field>
        )}
      </div>
      <Field label={ms ? "Mesej (jika dalam 24 jam). Token: {name} {need} {business}" : "Message (within 24h). Tokens: {name} {need} {business}"}>
        <textarea className="input" rows={2} value={f.message} placeholder="Hai {name}, masih berminat dengan {need}? Ada apa-apa soalan saya boleh bantu 😊" onChange={(e) => setFollow("message", e.target.value)} />
      </Field>
      <Field label={ms ? "Template diluluskan (selepas 24 jam — biasanya diperlukan)" : "Approved template (after 24h — usually required)"}>
        <select
          className="input"
          value={f.template_name ? `${f.template_name}|${f.template_language}` : ""}
          onChange={(e) => {
            const [name, language] = e.target.value.split("|");
            setFollow("template_name", name ?? "");
            if (language) setFollow("template_language", language);
          }}
        >
          <option value="">{ms ? "— tiada —" : "— none —"}</option>
          {templates.map((x) => <option key={`${x.name}|${x.language}`} value={`${x.name}|${x.language}`}>{x.name} ({x.language})</option>)}
        </select>
      </Field>
      {selected && (
        <div className="space-y-2 rounded-lg bg-zinc-50 p-3 text-sm">
          <p className="text-zinc-600">{selected.body_text}</p>
          {Array.from({ length: selected.variable_count }, (_, i) => (
            <div key={i} className="flex items-center gap-2">
              <code className="w-12">{`{{${i + 1}}}`}</code>
              <select
                className="input"
                value={f.template_variables[i] ?? "{name}"}
                onChange={(e) => {
                  const vars = [...f.template_variables];
                  while (vars.length < selected.variable_count) vars.push("{name}");
                  vars[i] = e.target.value;
                  setFollow("template_variables", vars.slice(0, selected.variable_count));
                }}
              >
                <option value="{name}">{ms ? "Nama pelanggan" : "Customer name"}</option>
                <option value="{need}">{ms ? "Keperluan" : "Need"}</option>
                <option value="{business}">{ms ? "Nama perniagaan" : "Business name"}</option>
              </select>
            </div>
          ))}
        </div>
      )}
      {f.enabled && !f.template_name && (
        <p className="text-xs text-amber-700">{ms ? "Tanpa template, susulan hanya boleh dihantar dalam 24 jam selepas mesej terakhir pelanggan." : "Without a template, follow-ups can only be sent within 24h of the customer's last message."}</p>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

function RowTools({ onUp, onDown, onDelete }: { onUp: () => void; onDown: () => void; onDelete: () => void }) {
  return (
    <div className="flex justify-end gap-1 text-xs">
      <button className="btn-secondary px-2 py-1" onClick={onUp} aria-label="up">↑</button>
      <button className="btn-secondary px-2 py-1" onClick={onDown} aria-label="down">↓</button>
      <button className="btn-danger px-2 py-1" onClick={onDelete} aria-label="delete">✕</button>
    </div>
  );
}

function ImportPanel({ lang, onMerge }: { lang: Lang; onMerge: (d: BrainDraft) => void }) {
  const t = dict(lang);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"pdf" | "url" | "text">("pdf");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<BrainDraft | null>(null);
  const [merged, setMerged] = useState(false);

  async function run() {
    setBusy(true);
    setErr(null);
    setDraft(null);
    setMerged(false);
    const fd = new FormData();
    fd.set("kind", kind);
    if (kind === "pdf" && file) fd.set("file", file);
    if (kind === "url") fd.set("url", url);
    if (kind === "text") fd.set("text", text);
    const res = await fetch("/api/dashboard/brain/extract", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (res.ok) setDraft(data.draft);
    else setErr(data.error ?? t("common.error"));
    setBusy(false);
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="w-full rounded-xl border-2 border-dashed border-zinc-300 p-4 text-sm font-medium text-zinc-600 hover:border-brand-500 hover:text-brand-700">
        📄 {t("brain.import")}
      </button>
    );
  }
  return (
    <section className="card space-y-3">
      <h2 className="text-lg font-semibold">{t("brain.import")}</h2>
      <p className="text-sm text-zinc-500">{t("brain.import.help")}</p>
      <div className="flex gap-2 text-sm">
        {(["pdf", "url", "text"] as const).map((k) => (
          <button key={k} onClick={() => setKind(k)} className={`rounded-full px-3 py-1 ${kind === k ? "bg-brand-700 text-white" : "bg-zinc-100"}`}>
            {t(`brain.import.${k}`)}
          </button>
        ))}
      </div>
      {kind === "pdf" && <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />}
      {kind === "url" && <input className="input" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />}
      {kind === "text" && <textarea className="input" rows={6} value={text} onChange={(e) => setText(e.target.value)} />}
      <button disabled={busy || (kind === "pdf" && !file)} onClick={run} className="btn-primary">{busy ? t("brain.import.running") : t("brain.import.run")}</button>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {draft && (
        <div className="space-y-2 rounded-lg bg-zinc-50 p-3 text-sm">
          <h3 className="font-semibold">{t("brain.import.review")}</h3>
          <DraftPreview d={draft} />
          {merged ? (
            <p className="text-brand-700">{t("brain.import.merged")}</p>
          ) : (
            <div className="flex gap-2">
              <button className="btn-primary" onClick={() => { onMerge(draft); setMerged(true); }}>{t("brain.import.merge")}</button>
              <button className="btn-secondary" onClick={() => setDraft(null)}>{t("brain.import.discard")}</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function DraftPreview({ d }: { d: BrainDraft }) {
  return (
    <div className="max-h-80 space-y-2 overflow-y-auto">
      {d.profile.description && <p><b>Profil:</b> {d.profile.description}</p>}
      {d.profile.operating_hours && <p><b>Waktu:</b> {d.profile.operating_hours}</p>}
      {d.products.length > 0 && (
        <ul className="list-disc pl-5">{d.products.map((p, i) => <li key={i}><b>{p.name}</b>{p.price && ` — ${p.price}`}{p.description && `: ${p.description}`}</li>)}</ul>
      )}
      {d.faqs.length > 0 && (
        <ul className="list-disc pl-5">{d.faqs.map((f, i) => <li key={i}><b>{f.q}</b> {f.a}</li>)}</ul>
      )}
      {Object.entries(d.policies).filter(([, v]) => v).map(([k, v]) => <p key={k}><b>{k}:</b> {v}</p>)}
      {d.extra_knowledge && <p className="whitespace-pre-wrap text-zinc-600">{d.extra_knowledge}</p>}
    </div>
  );
}
