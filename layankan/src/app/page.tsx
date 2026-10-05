import Link from "next/link";
import Script from "next/script";

const steps = [
  { t: "Daftar & isi Business Brain", d: "Produk, harga, FAQ, polisi — atau muat naik PDF / tampal laman web anda." },
  { t: "Uji ejen anda", d: "Berbual dengan ejen anda sendiri sebelum pelanggan nampak." },
  { t: "Go Live", d: "Dapat pautan chat, kod QR dan widget laman web. WhatsApp rasmi akan datang." },
  { t: "Terima pembeli serius", d: "AI layan 24/7, tapis 'Hi, harga?', nilai prospek dan serahkan yang PANAS kepada anda." },
];

export default function Landing() {
  return (
    <div className="bg-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between p-4">
        <span className="text-2xl font-extrabold text-brand-700">Layankan</span>
        <nav className="flex items-center gap-3 text-sm">
          <Link href="/login" className="font-medium text-zinc-600">Log masuk</Link>
          <Link href="/signup" className="btn-primary">Cuba percuma</Link>
        </nav>
      </header>

      <section className="mx-auto max-w-6xl px-4 pb-16 pt-10 text-center md:pt-20">
        <p className="mb-3 inline-block rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">Untuk PKS Malaysia 🇲🇾</p>
        <h1 className="mx-auto max-w-3xl text-4xl font-extrabold leading-tight tracking-tight md:text-6xl">
          Penat jawab <span className="text-brand-700">“Hi, harga?”</span> yang terus senyap?
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-zinc-600">
          Layankan ialah ejen AI yang menjawab pertanyaan pelanggan anda serta-merta, 24/7, dalam BM &amp; English — menapis pertanyaan kosong,
          menilai setiap prospek <b>PANAS / SUAM / SEJUK</b>, dan hanya menyerahkan pembeli serius kepada anda.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/c/layankan" className="btn-primary px-6 py-3 text-base">💬 Cuba demo sekarang</Link>
          <Link href="/signup" className="btn-secondary px-6 py-3 text-base">Daftar perniagaan anda</Link>
        </div>
        <p className="mt-3 text-xs text-zinc-400">Demo ini ialah Layankan sendiri — tanya apa sahaja tentang kami.</p>
      </section>

      <section className="bg-zinc-50 py-16">
        <div className="mx-auto grid max-w-6xl gap-4 px-4 md:grid-cols-4">
          {steps.map((s, i) => (
            <div key={s.t} className="card">
              <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-brand-700 font-bold text-white">{i + 1}</div>
              <h3 className="font-semibold">{s.t}</h3>
              <p className="mt-1 text-sm text-zinc-600">{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-8 px-4 py-16 md:grid-cols-3">
        {[
          ["🔥 PANAS", "Sedia beli. Anda dimaklumkan serta-merta, AI berhenti, anda ambil alih."],
          ["🌤 SUAM", "Berminat tapi belum pasti. Disenaraikan dalam ringkasan harian untuk susulan."],
          ["❄️ SEJUK", "Sekadar tinjau. AI layan dengan sopan — masa anda tidak terbuang."],
        ].map(([h, d]) => (
          <div key={h}>
            <h3 className="text-xl font-bold">{h}</h3>
            <p className="mt-2 text-zinc-600">{d}</p>
          </div>
        ))}
      </section>

      <section className="bg-brand-900 py-16 text-white">
        <div className="mx-auto max-w-3xl px-4 text-center">
          <h2 className="text-3xl font-extrabold">Founding Offer — 3 slot sahaja</h2>
          <p className="mt-3 text-4xl font-extrabold">RM500 <span className="text-lg font-medium">setup</span> + RM300<span className="text-lg font-medium">/bulan</span></p>
          <p className="mt-3 text-white/80">Kami setupkan Business Brain anda, uji bersama, dan Go Live dalam 3–5 hari bekerja.</p>
          <Link href="/c/layankan" className="btn mt-6 bg-white px-6 py-3 text-base text-brand-900 hover:bg-brand-50">Tanya ejen kami tentang slot</Link>
        </div>
      </section>

      <footer className="mx-auto flex max-w-6xl flex-wrap justify-between gap-2 p-6 text-sm text-zinc-500">
        <span>© {new Date().getFullYear()} Layankan</span>
        <Link href="/privacy" className="underline">Notis Privasi / Privacy Notice</Link>
      </footer>

      {/* Dogfooding: our own widget, served by our own agent. */}
      <Script src="/widget.js" data-layankan="layankan" strategy="lazyOnload" />
    </div>
  );
}
