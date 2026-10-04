const styles: Record<string, string> = {
  PANAS: "bg-red-100 text-red-800",
  SUAM: "bg-amber-100 text-amber-800",
  SEJUK: "bg-sky-100 text-sky-800",
};
const icons: Record<string, string> = { PANAS: "🔥", SUAM: "🌤", SEJUK: "❄️" };

export default function ScoreBadge({ score }: { score: string | null }) {
  if (!score) return <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-500">—</span>;
  return (
    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ${styles[score] ?? ""}`}>
      {icons[score]} {score}
    </span>
  );
}
