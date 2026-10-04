/** "Why PANAS? <reason>" — the AI's one-line reason for a lead's score, for the owner. */
export default function WhyScore({ score, reason, lang, compact = false }: { score: string | null; reason: string | null; lang: "ms" | "en"; compact?: boolean }) {
  if (!score || !reason) return null;
  const q = lang === "ms" ? `Kenapa ${score}?` : `Why ${score}?`;
  return (
    <p className={`text-xs text-zinc-600 ${compact ? "line-clamp-2" : ""}`}>
      <span className="font-semibold text-zinc-800">{q}</span> {reason}
    </p>
  );
}
