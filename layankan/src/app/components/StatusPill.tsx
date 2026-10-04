export default function StatusPill({ status, label }: { status: string; label: string }) {
  const s: Record<string, string> = {
    ai: "bg-brand-50 text-brand-700",
    needs_human: "bg-amber-100 text-amber-800 font-semibold",
    human: "bg-violet-100 text-violet-800",
    closed: "bg-zinc-100 text-zinc-500",
  };
  return <span className={`rounded px-1.5 py-0.5 ${s[status] ?? ""}`}>{label}</span>;
}
