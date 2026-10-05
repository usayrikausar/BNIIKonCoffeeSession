import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import OnboardingForm from "./OnboardingForm";

export const metadata = { title: "Mula" };

export default async function Page() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return (
    <div className="mx-auto mt-12 max-w-lg px-4 pb-16">
      <div className="mb-6 text-center">
        <div className="text-2xl font-extrabold text-brand-700">Layankan</div>
        <h1 className="mt-4 text-2xl font-bold">Cipta ruang kerja anda</h1>
        <p className="mt-1 text-sm text-zinc-500">Create your workspace — takes 30 seconds.</p>
      </div>
      <ol className="mb-6 grid grid-cols-4 gap-2 text-center text-xs text-zinc-500">
        <li className="rounded-lg bg-brand-100 p-2 font-semibold text-brand-900">1. Ruang kerja</li>
        <li className="rounded-lg bg-white p-2">2. Business Brain</li>
        <li className="rounded-lg bg-white p-2">3. Uji</li>
        <li className="rounded-lg bg-white p-2">4. Go Live</li>
      </ol>
      <OnboardingForm appUrl={env.appUrl()} />
    </div>
  );
}
