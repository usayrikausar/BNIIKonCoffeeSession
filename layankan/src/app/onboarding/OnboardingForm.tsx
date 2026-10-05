"use client";
import { useActionState, useState } from "react";
import { createWorkspace } from "./actions";
import { INDUSTRIES, INDUSTRY_LABELS } from "@/lib/brain/schema";

function slugify(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export default function OnboardingForm({ appUrl }: { appUrl: string }) {
  const [state, action, pending] = useActionState(createWorkspace, null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [touched, setTouched] = useState(false);

  return (
    <form action={action} className="card space-y-4">
      <div>
        <label className="label" htmlFor="name">Nama perniagaan / Business name</label>
        <input
          id="name"
          name="name"
          required
          className="input"
          value={name}
          placeholder="cth. Klinik Ana"
          onChange={(e) => {
            setName(e.target.value);
            if (!touched) setSlug(slugify(e.target.value));
          }}
        />
      </div>
      <div>
        <label className="label" htmlFor="slug">Pautan chat anda / Your chat link</label>
        <div className="flex items-center rounded-lg border border-zinc-300 bg-white text-sm">
          <span className="whitespace-nowrap pl-3 text-zinc-400">{appUrl.replace(/^https?:\/\//, "")}/c/</span>
          <input
            id="slug"
            name="slug"
            required
            className="w-full bg-transparent py-2 pr-3 outline-none"
            value={slug}
            onChange={(e) => {
              setTouched(true);
              setSlug(slugify(e.target.value));
            }}
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="industry">Industri / Industry</label>
        <select id="industry" name="industry" className="input" defaultValue="umum">
          {INDUSTRIES.map((i) => (
            <option key={i} value={i}>
              {INDUSTRY_LABELS[i].ms} / {INDUSTRY_LABELS[i].en}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-zinc-500">Kami isi soalan penapis yang sesuai untuk industri anda. Boleh ubah kemudian.</p>
      </div>
      {state?.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{state.error}</p>}
      <button disabled={pending} className="btn-primary w-full">{pending ? "…" : "Cipta & teruskan / Create & continue"}</button>
    </form>
  );
}
