export const metadata = { title: "Notis Privasi" };

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-12 text-sm leading-relaxed text-zinc-700">
      <h1 className="text-2xl font-bold text-zinc-900">Notis Privasi (PDPA 2010)</h1>
      <p>
        Chat ini dikendalikan oleh perniagaan yang anda hubungi (&quot;Perniagaan&quot;) menggunakan platform Layankan. Perniagaan
        ialah pengguna data; Layankan memproses data bagi pihak Perniagaan.
      </p>
      <h2 className="font-semibold text-zinc-900">Data yang dikumpul</h2>
      <p>Mesej yang anda hantar dan apa-apa maklumat yang anda kongsi di dalamnya (cth. nama, nombor telefon, keperluan, bajet).</p>
      <h2 className="font-semibold text-zinc-900">Tujuan</h2>
      <p>
        Untuk menjawab pertanyaan anda, memahami keperluan anda, dan membolehkan Perniagaan menghubungi anda. Mesej diproses oleh
        sistem AI (Anthropic Claude) untuk menjana jawapan dan menilai pertanyaan. Data anda tidak dijual dan tidak dikongsi dengan
        perniagaan lain.
      </p>
      <h2 className="font-semibold text-zinc-900">Hak anda</h2>
      <p>
        Anda boleh meminta akses, pembetulan atau pemadaman data anda dengan menghubungi Perniagaan secara terus, atau dengan
        menulis &quot;padam data saya&quot; di dalam chat — Perniagaan akan memadam perbualan anda.
      </p>
      <h2 className="font-semibold text-zinc-900">Penyimpanan &amp; keselamatan</h2>
      <p>Data disimpan secara selamat dan diasingkan bagi setiap perniagaan. Kelayakan sambungan saluran disulitkan.</p>
      <hr />
      <h2 className="font-semibold text-zinc-900">English summary</h2>
      <p>
        This chat is operated by the business you are contacting, using the Layankan platform. Your messages are stored and processed
        (including by AI) only to answer your enquiry and let the business follow up. Data is never sold or shared with other
        businesses. Ask the business to access, correct or delete your data at any time.
      </p>
    </div>
  );
}
