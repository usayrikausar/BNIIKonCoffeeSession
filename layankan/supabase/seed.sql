-- Tenant #1: Layankan itself (dogfooding). This is the live demo prospects try
-- from the landing page at /c/layankan. To manage it from the dashboard, sign up
-- with your founder email, then run (SQL editor):
--   insert into tenant_members (tenant_id, user_id, role, email)
--   select '00000000-0000-4000-8000-000000000001', id, 'owner', email from auth.users where email = 'YOU@EXAMPLE.COM';
insert into public.tenants (id, slug, name, status, timezone, default_locale, live_at)
values ('00000000-0000-4000-8000-000000000001', 'layankan', 'Layankan', 'live', 'Asia/Kuala_Lumpur', 'ms', now())
on conflict (id) do nothing;

insert into public.channel_connections (tenant_id, channel, provider, status)
values ('00000000-0000-4000-8000-000000000001', 'web', 'web', 'connected')
on conflict do nothing;

insert into public.business_brains (tenant_id, profile, products, faqs, policies, qualifying_questions, handoff_rules, extra_knowledge)
values (
  '00000000-0000-4000-8000-000000000001',
  $json${
    "name": "Layankan",
    "industry": "saas",
    "description": "Ejen AI yang menjawab pertanyaan pelanggan perniagaan anda 24/7 dalam Bahasa Malaysia dan English, menapis pertanyaan kosong, menilai setiap prospek (PANAS / SUAM / SEJUK) dan hanya menyerahkan pembeli serius kepada anda.",
    "location": "Malaysia (servis dalam talian, seluruh negara)",
    "operating_hours": "Ejen AI 24/7. Pasukan manusia: Isnin–Jumaat, 9 pagi – 6 petang.",
    "tone": "santai",
    "languages": ["ms", "en"]
  }$json$::jsonb,
  $json$[
    {
      "name": "Founding Offer (terhad 3 slot)",
      "description": "Setup penuh Business Brain anda oleh pasukan kami, ejen AI untuk chat web + pautan + kod QR + widget laman web, papan pemuka prospek, makluman serah-tangan dan ringkasan harian. Sambungan WhatsApp Business rasmi apabila sedia (Fasa 2).",
      "price": "RM500 setup + RM300/bulan",
      "suits": "PKS yang terima banyak pertanyaan di WhatsApp/web dan penat jawab soalan sama berulang kali — klinik, salun, hartanah, kursus, F&B katering, servis rumah."
    }
  ]$json$::jsonb,
  $json$[
    {"q": "Layankan ni apa?", "a": "Ejen AI yang jawab pertanyaan pelanggan anda serta-merta, 24/7, dalam BM & English. Dia tanya soalan penapis, nilai prospek PANAS/SUAM/SEJUK, dan serahkan pembeli serius kepada anda."},
    {"q": "Perlu pandai IT?", "a": "Tak perlu. Anda isi maklumat perniagaan (produk, harga, FAQ, polisi) dalam borang mudah, tekan Test, kemudian Go Live. Untuk Founding Offer, kami setupkan untuk anda."},
    {"q": "Boleh guna WhatsApp?", "a": "Sekarang chat web (pautan, kod QR, widget laman web). Sambungan WhatsApp Business rasmi (API Meta) sedang dibina — nombor kekal milik anda."},
    {"q": "AI akan reka harga?", "a": "Tidak. Ejen hanya jawab berdasarkan maklumat yang anda beri. Kalau tak pasti, dia akan cakap terus terang dan serahkan kepada anda."},
    {"q": "Data pelanggan selamat?", "a": "Data setiap perniagaan diasingkan sepenuhnya, dan kami ikut PDPA. Anda boleh eksport atau padam data pelanggan bila-bila masa."},
    {"q": "Ada kontrak?", "a": "Bulanan. Founding Offer: RM500 setup sekali + RM300 sebulan. Boleh berhenti dengan notis 30 hari."}
  ]$json$::jsonb,
  $json${
    "booking": "Demo 20 minit melalui Google Meet atau WhatsApp call, ikut masa yang sesuai untuk anda.",
    "payment": "Setup RM500 dibayar sebelum setup bermula. Langganan RM300 dibayar bulanan.",
    "delivery": "Setup siap dalam 3–5 hari bekerja selepas kami terima maklumat perniagaan anda.",
    "refunds": "Jika setup belum dimulakan, bayaran setup dipulangkan penuh. Langganan bulanan tidak dipulangkan untuk bulan yang sedang berjalan."
  }$json$::jsonb,
  $json$[
    "Perniagaan anda jenis apa?",
    "Lebih kurang berapa banyak pertanyaan pelanggan sehari?",
    "Siapa yang jawab pertanyaan sekarang — anda sendiri atau staf?",
    "Bila anda perlukan penyelesaian ini — segera, bulan ini, atau sekadar meninjau?"
  ]$json$::jsonb,
  $json${"ready_to_buy": true, "complaint": true, "ai_unsure": true, "asked_for_human": true, "owner_whatsapp": "", "min_confidence": 0.5}$json$::jsonb,
  'Founding Offer hanya untuk 3 perniagaan pertama. PANAS = mahu mula dalam bulan ini dan sesuai dengan pakej. SUAM = berminat tetapi masa tidak pasti. SEJUK = sekadar ingin tahu.'
)
on conflict (tenant_id) do nothing;
