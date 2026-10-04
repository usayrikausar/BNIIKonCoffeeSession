"use client";
import { useMemo, useState } from "react";
import type { Lang } from "@/lib/i18n";

export interface Summary {
  conversations?: number;
  by_score?: Record<string, number>;
  by_channel?: Record<string, number>;
  daily?: { day: string; PANAS: number; SUAM: number; SEJUK: number; NONE: number }[];
  conversion?: Record<string, { leads: number; won: number; lost: number; value_cents: number }>;
  handoffs?: number;
  empty_enquiries?: number;
  first_response_median_s?: number | null;
  first_response_p90_s?: number | null;
  human_response_median_s?: number | null;
  messages?: { customer: number; ai: number; human: number; system: number };
}

// Ordered hot → cold. Validated (dataviz validator, light surface): CVD ΔE ≥ 15,
// normal-vision ΔE ≥ 20. Yellow < 3:1 contrast → values are always shown as text too.
const SERIES = [
  { key: "PANAS", label: "🔥 PANAS", color: "#e34948" },
  { key: "SUAM", label: "🌤 SUAM", color: "#eda100" },
  { key: "SEJUK", label: "❄️ SEJUK", color: "#2a78d6" },
  { key: "NONE", label: "—", color: "#c3c2b7" },
] as const;

function duration(s: number | null | undefined, ms: boolean) {
  if (s == null) return "—";
  if (s < 60) return `${Math.round(s)} ${ms ? "saat" : "s"}`;
  if (s < 3600) return `${Math.round(s / 60)} ${ms ? "min" : "min"}`;
  return `${(s / 3600).toFixed(1)} ${ms ? "jam" : "h"}`;
}

export default function AnalyticsView(props: {
  lang: Lang;
  days: number;
  fromIso: string;
  timezone: string;
  summary: Summary;
  usage: { used: number; limit: number; planName: string };
}) {
  const ms = props.lang === "ms";
  const s = props.summary;
  const conv = s.conversion ?? {};
  const won = Object.values(conv).reduce((a, c) => a + c.won, 0);
  const total = s.conversations ?? 0;
  const value = Object.values(conv).reduce((a, c) => a + c.value_cents, 0);

  const tiles = [
    { label: ms ? "Perbualan" : "Conversations", value: total.toLocaleString(), sub: `${s.by_channel?.whatsapp ?? 0} WhatsApp · ${s.by_channel?.web ?? 0} web` },
    { label: "🔥 PANAS", value: (s.by_score?.PANAS ?? 0).toLocaleString(), sub: `${s.handoffs ?? 0} ${ms ? "diserahkan kepada anda" : "handed to you"}` },
    { label: ms ? "Jadi pelanggan" : "Won", value: won.toLocaleString(), sub: `${total ? Math.round((won / total) * 100) : 0}% · RM${(value / 100).toLocaleString("en-MY")}` },
    { label: ms ? "Masa balas pertama (median)" : "First response (median)", value: duration(s.first_response_median_s, ms), sub: `p90 ${duration(s.first_response_p90_s, ms)}` },
    { label: ms ? "Masa balas anda selepas serahan" : "Your response after handoff", value: duration(s.human_response_median_s, ms), sub: ms ? "median" : "median" },
    { label: ms ? "Pertanyaan kosong ditapis" : "Empty enquiries filtered", value: (s.empty_enquiries ?? 0).toLocaleString(), sub: ms ? "\"Hi, harga?\" lalu senyap" : "\"Hi, price?\" then silent" },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {tiles.map((t) => (
          <div key={t.label} className="card p-4">
            <div className="text-xs text-zinc-500">{t.label}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums">{t.value}</div>
            <div className="mt-0.5 text-xs text-zinc-500">{t.sub}</div>
          </div>
        ))}
      </div>
      <UsageMeter ms={ms} {...props.usage} />
      <DailyChart ms={ms} days={props.days} fromIso={props.fromIso} timezone={props.timezone} daily={s.daily ?? []} />
      <ConversionBars ms={ms} conversion={conv} />
    </div>
  );
}

function UsageMeter({ ms, used, limit, planName }: { ms: boolean; used: number; limit: number; planName: string }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-semibold">{ms ? "Balasan AI bulan ini" : "AI replies this period"} · {planName}</span>
        <span className="tabular-nums text-zinc-600">{used.toLocaleString()} / {limit.toLocaleString()}</span>
      </div>
      <div className="mt-2 h-2 rounded-full bg-zinc-100" role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit}>
        <div className={`h-2 rounded-full ${pct >= 100 ? "bg-red-600" : pct >= 80 ? "bg-amber-500" : "bg-brand-600"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function DailyChart({ ms, days, fromIso, timezone, daily }: { ms: boolean; days: number; fromIso: string; timezone: string; daily: NonNullable<Summary["daily"]> }) {
  const [hover, setHover] = useState<number | null>(null);
  // Fill every day in range (zero days are data too).
  const rows = useMemo(() => {
    const byDay = new Map(daily.map((d) => [d.day, d]));
    const out: { day: string; PANAS: number; SUAM: number; SEJUK: number; NONE: number }[] = [];
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    for (let i = 1; i <= days; i++) {
      const key = fmt.format(new Date(Date.parse(fromIso) + i * 86_400_000));
      out.push(byDay.get(key) ?? { day: key, PANAS: 0, SUAM: 0, SEJUK: 0, NONE: 0 });
    }
    return out;
  }, [daily, days, fromIso, timezone]);

  const max = Math.max(1, ...rows.map((r) => r.PANAS + r.SUAM + r.SEJUK + r.NONE));
  const niceMax = max <= 4 ? 4 : Math.ceil(max / 4) * 4; // keeps the mid tick a whole number
  const W = 720, H = 220, L = 32, B = 22, T = 8;
  const band = (W - L) / rows.length;
  const barW = Math.min(24, Math.max(2, band - 2));
  const y = (v: number) => T + (H - T - B) * (1 - v / niceMax);
  const ticks = [0, niceMax / 2, niceMax];

  return (
    <section className="card p-4">
      <h2 className="font-semibold">{ms ? "Prospek baharu setiap hari, mengikut skor" : "New leads per day, by score"}</h2>
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-zinc-600">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.key === "NONE" ? (ms ? "Belum dinilai" : "Not scored") : s.label}</span>
        ))}
      </div>
      <div className="relative mt-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={ms ? "Carta prospek harian" : "Daily leads chart"} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={L} x2={W} y1={y(t)} y2={y(t)} stroke="#e7e5e4" strokeWidth={1} />
              <text x={L - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="#78716c">{t}</text>
            </g>
          ))}
          {rows.map((r, i) => {
            const x = L + i * band + (band - barW) / 2;
            let acc = 0;
            const segs = SERIES.map((s) => ({ s, v: r[s.key] })).filter((p) => p.v > 0);
            return (
              <g key={r.day}>
                {segs.map((p, j) => {
                  const y0 = y(acc), y1 = y(acc + p.v);
                  acc += p.v;
                  const top = j === segs.length - 1;
                  const h = Math.max(0, y0 - y1 - (top ? 0 : 2)); // 2px surface gap between segments
                  return top ? (
                    <path key={p.s.key} d={roundedTop(x, y1, barW, h, Math.min(4, h, barW / 2))} fill={p.s.color} opacity={hover == null || hover === i ? 1 : 0.45} />
                  ) : (
                    <rect key={p.s.key} x={x} y={y1 + 2} width={barW} height={h} fill={p.s.color} opacity={hover == null || hover === i ? 1 : 0.45} />
                  );
                })}
                {/* hit target: the whole column band */}
                <rect x={L + i * band} y={T} width={band} height={H - T - B} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1} />
                {(i === 0 || i === rows.length - 1 || (rows.length <= 14 && i % 2 === 0)) && (
                  <text
                    x={i === rows.length - 1 ? W : i === 0 ? L : L + i * band + band / 2}
                    y={H - 6}
                    textAnchor={i === rows.length - 1 ? "end" : i === 0 ? "start" : "middle"}
                    fontSize={10}
                    fill="#78716c"
                  >
                    {r.day.slice(5)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {hover != null && rows[hover] && (
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-lg bg-white px-3 py-2 text-xs shadow-lg ring-1 ring-zinc-200"
            style={{ left: `${Math.min(80, ((L + hover * band) / W) * 100)}%` }}
          >
            <div className="mb-1 font-semibold">{rows[hover].day}</div>
            {SERIES.map((s) => (
              <div key={s.key} className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
                <span className="text-zinc-600">{s.key === "NONE" ? (ms ? "Belum dinilai" : "Not scored") : s.key}</span>
                <span className="ml-auto pl-3 font-semibold tabular-nums">{rows[hover][s.key]}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-zinc-600">{ms ? "Lihat sebagai jadual" : "View as table"}</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full text-left text-xs tabular-nums">
            <thead className="text-zinc-500"><tr><th className="py-1">{ms ? "Tarikh" : "Date"}</th>{SERIES.map((s) => <th key={s.key} className="py-1 text-right">{s.key === "NONE" ? "—" : s.key}</th>)}</tr></thead>
            <tbody>
              {rows.filter((r) => r.PANAS + r.SUAM + r.SEJUK + r.NONE > 0).map((r) => (
                <tr key={r.day} className="border-t border-zinc-100"><td className="py-1">{r.day}</td>{SERIES.map((s) => <td key={s.key} className="py-1 text-right">{r[s.key]}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  if (h <= 0) return "";
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function ConversionBars({ ms, conversion }: { ms: boolean; conversion: NonNullable<Summary["conversion"]> }) {
  const rows = SERIES.filter((s) => s.key !== "NONE").map((s) => {
    const c = conversion[s.key] ?? { leads: 0, won: 0, lost: 0, value_cents: 0 };
    return { ...s, ...c, rate: c.leads ? c.won / c.leads : 0 };
  });
  return (
    <section className="card p-4">
      <h2 className="font-semibold">{ms ? "Kadar jadi pelanggan mengikut skor" : "Conversion rate by score"}</h2>
      <p className="text-xs text-zinc-500">
        {ms ? "Tandakan perbualan sebagai \"Jadi pelanggan\" atau \"Tak jadi\" dalam Peti Masuk untuk mengukur ketepatan skor." : "Mark conversations Won / Lost in the Inbox to measure how well scores predict sales."}
      </p>
      <div className="mt-3 space-y-3">
        {rows.map((r) => (
          <div key={r.key} className="grid grid-cols-[80px_1fr_120px] items-center gap-3 text-sm">
            <span className="text-zinc-700">{r.label}</span>
            <div className="h-3 rounded-full bg-zinc-100" title={`${r.won}/${r.leads}`}>
              <div className="h-3 rounded-r-[4px]" style={{ width: `${Math.max(r.rate * 100, r.won ? 2 : 0)}%`, background: r.color, borderTopLeftRadius: 9999, borderBottomLeftRadius: 9999 }} />
            </div>
            <span className="tabular-nums text-zinc-700">
              {Math.round(r.rate * 100)}% <span className="text-xs text-zinc-500">({r.won}/{r.leads})</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
