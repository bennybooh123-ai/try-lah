import { useEffect, useState, useCallback } from "react";
import { api, fmtHKD } from "@/lib/api";
import { toast } from "sonner";
import { ShieldCheck, ShieldAlert, RefreshCw } from "lucide-react";

export default function Audit() {
  const [entries, setEntries] = useState([]);
  const [verify, setVerify] = useState(null);

  const load = useCallback(async () => setEntries((await api.get("/audit")).data), []);
  useEffect(() => { load(); }, [load]);

  const runVerify = async () => {
    const r = await api.get("/audit/verify");
    setVerify(r.data);
    r.data.valid ? toast.success(`Chain intact — ${r.data.entries} entries verified`) : toast.error(`CHAIN BROKEN at seq ${r.data.broken_at_seq}`);
  };

  const KIND_COLOR = { payment: "var(--emerald)", void: "var(--rose)", tournament_entry: "var(--cyan)", tournament_payout: "var(--amber)" };

  return (
    <div data-testid="audit-page">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="font-display font-black text-3xl">Audit Chain</h1>
          <p className="text-xs font-mono text-[var(--muted)] uppercase tracking-widest mt-1">Append-only · SHA-256 hash-chained · tamper-evident</p>
        </div>
        <button data-testid="verify-chain-btn" onClick={runVerify} className="btn-neon px-4 py-2 rounded-lg flex items-center gap-2"><RefreshCw size={16} /> Verify Chain</button>
      </div>

      {verify && (
        <div className={`mb-4 rounded-xl border p-4 flex items-center gap-3 ${verify.valid ? "border-[var(--emerald)]/50 bg-[var(--emerald)]/5" : "border-[var(--rose)]/50 bg-[var(--rose)]/5"}`} data-testid="verify-result">
          {verify.valid ? <ShieldCheck size={20} className="text-[var(--emerald)]" /> : <ShieldAlert size={20} className="text-[var(--rose)]" />}
          <span className="text-sm font-semibold">
            {verify.valid ? `Chain intact — ${verify.entries} entries, all hashes valid` : `TAMPER DETECTED at entry #${verify.broken_at_seq} (${verify.reason})`}
          </span>
        </div>
      )}

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
        <div className="p-3 grid grid-cols-12 text-[10px] font-mono uppercase tracking-widest text-[var(--muted)]">
          <span className="col-span-1">Seq</span><span className="col-span-2">Kind</span><span className="col-span-5">Event</span><span className="col-span-2">Actor</span><span className="col-span-2">Hash</span>
        </div>
        {entries.map((e) => (
          <div key={e.id} className="p-3 grid grid-cols-12 text-sm items-center" data-testid={`audit-entry-${e.seq}`}>
            <span className="col-span-1 font-mono text-[var(--muted)]">#{e.seq}</span>
            <span className="col-span-2">
              <span className="px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase" style={{ background: `${KIND_COLOR[e.kind] || "#94A3B8"}22`, color: KIND_COLOR[e.kind] || "#94A3B8" }}>{e.kind}</span>
            </span>
            <span className="col-span-5 text-xs text-[var(--muted)] truncate pr-2">
              {e.kind === "payment" && `${fmtHKD(e.payload.total)} via ${e.payload.method}${e.payload.channel ? ` (${e.payload.channel})` : ""}`}
              {e.kind === "void" && `${e.payload.qty}× ${e.payload.item} — ${e.payload.reason} (${fmtHKD(e.payload.amount)}) approved by ${e.payload.approved_by}`}
              {e.kind === "tournament_entry" && `Entry ${e.payload.player} — ${fmtHKD(e.payload.amount)} (${e.payload.tournament})`}
              {e.kind === "tournament_payout" && `${e.payload.place} prize ${e.payload.recipient} — ${fmtHKD(e.payload.amount)} (${e.payload.tournament})`}
            </span>
            <span className="col-span-2 text-xs">{e.actor}</span>
            <span className="col-span-2 font-mono text-[10px] text-[var(--muted)] truncate" title={e.hash}>{e.hash?.slice(0, 12)}…</span>
          </div>
        ))}
        {entries.length === 0 && <div className="p-8 text-center text-[var(--muted)] text-sm">No audit entries yet — payments and voids are chained automatically</div>}
      </div>
    </div>
  );
}
