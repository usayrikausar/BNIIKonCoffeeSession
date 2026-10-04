"use client";
import { useState, useTransition } from "react";
import { adminExtendTrial, adminGrantPlan, adminMarkPaid } from "./actions";

export default function AdminActions(props: { kind: "markPaid" | "tenant"; id: string; plans?: { id: string; name: string }[]; trial?: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [plan, setPlan] = useState(props.plans?.[0]?.id ?? "");
  const run = (fn: () => Promise<string>) => start(async () => setMsg(await fn()));
  if (props.kind === "markPaid") {
    return (
      <span className="flex items-center justify-end gap-2">
        {msg && <span className="text-xs">{msg}</span>}
        <button disabled={pending} onClick={() => confirm("Mark this invoice PAID?") && run(() => adminMarkPaid(props.id))} className="btn-primary px-2 py-1 text-xs">Mark paid</button>
      </span>
    );
  }
  return (
    <span className="flex items-center justify-end gap-1">
      {msg && <span className="text-xs">{msg}</span>}
      <select value={plan} onChange={(e) => setPlan(e.target.value)} className="input w-28 py-1 text-xs">
        {props.plans?.filter((p) => p.id !== "trial").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <button disabled={pending} onClick={() => confirm(`Grant 1 month of ${plan} (manual invoice, marked paid)?`) && run(() => adminGrantPlan(props.id, plan))} className="btn-secondary px-2 py-1 text-xs">Grant</button>
      {props.trial && <button disabled={pending} onClick={() => run(() => adminExtendTrial(props.id, 7))} className="btn-secondary px-2 py-1 text-xs">+7d trial</button>}
    </span>
  );
}
