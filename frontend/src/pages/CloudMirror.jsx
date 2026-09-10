import { useEffect, useState, useCallback } from "react";
import { api, fmtHKD } from "@/lib/api";
import { toast } from "sonner";
import { Cloud, RefreshCw, ShieldCheck, BellRing, CalendarClock, Ban } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

const MIRROR_TOOLTIP_STYLE = { background: "#1A1D2B", border: "1px solid #282C3F" };
const MIRROR_DOT_STYLE = { r: 3 };

export default function CloudMirror() {
  const [status, setStatus] = useState(null);
  const [report, setReport] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setStatus((await api.get("/cloud/status")).data);
    try { setReport((await api.get("/cloud/report")).data); setErr(null); }
    catch (e) { setErr(e?.response?.data?.detail || e.message); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  const syncNow = async () => {
    try { await api.post("/cloud/sync"); toast.success("Aggregates pushed to cloud mirror"); load(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Sync failed"); load(); }
  };

  const latest = report?.latest;

  return (
    <div data-testid="cloud-mirror-panel">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="font-display font-black text-3xl">Cloud Mirror</h1>
          <p className="text-xs font-mono text-[var(--muted)] uppercase tracking-widest mt-1">owner remote reports · read-only aggregates</p>
        </div>
        <button data-testid="sync-now-btn" onClick={syncNow} className="btn-neon px-4 py-2 rounded-lg flex items-center gap-2"><RefreshCw size={16} /> Sync Now</button>
      </div>

      <div className="mb-4 rounded-xl border border-[var(--emerald)]/40 bg-[var(--emerald)]/5 p-4 flex items-center gap-3">
        <ShieldCheck size={20} className="text-[var(--emerald)] shrink-0" />
        <p className="text-sm text-[var(--muted)]">
          <span className="text-white font-semibold">Push-only architecture.</span> The on-prem server pushes aggregates OUT.
          The cloud never touches the live register — no inbound hole into the store network. Internet down = service continues, sync resumes later.
        </p>
      </div>

      {status && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"><div className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)] mb-1">Mirror URL</div><div className="font-mono text-sm" data-testid="mirror-url">{status.mirror_url}</div></div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"><div className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)] mb-1">Last Sync</div><div className="font-mono text-sm" data-testid="last-sync">{status.last_sync ? new Date(status.last_sync).toLocaleString() : "never"}</div></div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"><div className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)] mb-1">Status</div>
            <div className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase w-fit ${status.last_sync_status === "ok" ? "bg-[var(--emerald)]/15 text-[var(--emerald)]" : "bg-[var(--rose)]/15 text-[var(--rose)]"}`} data-testid="sync-status">{status.last_sync_status || "—"}</div></div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"><div className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)] mb-1">Auto Interval</div><div className="font-mono text-sm">{status.interval_seconds}s</div></div>
        </div>
      )}

      {err && <div className="mb-4 rounded-xl border border-[var(--rose)]/50 bg-[var(--rose)]/5 p-4 text-[var(--rose)] text-sm" data-testid="mirror-error"><Cloud size={16} className="inline mr-2" />Mirror unreachable: {err} — POS unaffected.</div>}

      {latest && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"><div className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)] mb-1">Revenue (mirror)</div><div className="font-display font-black text-2xl text-[var(--cyan)]" data-testid="mirror-revenue">{fmtHKD(latest.sales?.total_revenue)}</div></div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"><div className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)] mb-1">Paid Orders</div><div className="font-display font-black text-2xl">{latest.sales?.paid_orders ?? 0}</div></div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"><div className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)] mb-1">Low Stock</div><div className="font-display font-black text-2xl text-[var(--rose)]" data-testid="mirror-low-stock">{(latest.low_stock || []).length}</div></div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"><div className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)] mb-1">Snapshot</div><div className="font-mono text-xs text-[var(--muted)]">{new Date(latest.ts).toLocaleString()}</div></div>
          </div>

          {/* Pre-shift briefing + owner alerts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <div className="rounded-xl border border-[var(--amber)]/40 bg-[var(--amber)]/5 p-4" data-testid="briefing-card">
              <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-[var(--amber)] font-bold mb-3">
                <CalendarClock size={14} /> Pre-shift Briefing
              </div>
              <div className="space-y-2 text-sm">
                <div><span className="text-[var(--muted)]">Low stock:</span>{" "}
                  {latest.briefing?.low_stock?.length ? latest.briefing.low_stock.join(", ") : <span className="text-[var(--emerald)]">none</span>}</div>
                <div><span className="text-[var(--muted)]">86'd items:</span>{" "}
                  {latest.briefing?.eightysixed?.length ? latest.briefing.eightysixed.join(", ") : <span className="text-[var(--emerald)]">none</span>}</div>
                <div><span className="text-[var(--muted)]">Events today:</span>{" "}
                  {latest.briefing?.events_today?.length ? latest.briefing.events_today.join(", ") : "none scheduled"}</div>
              </div>
            </div>
            <div className="rounded-xl border border-[var(--rose)]/40 bg-[var(--rose)]/5 p-4" data-testid="owner-alerts-card">
              <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-[var(--rose)] font-bold mb-3">
                <BellRing size={14} /> Owner Alerts ({(latest.alerts || []).length})
              </div>
              <div className="space-y-1.5 text-sm max-h-40 overflow-y-auto">
                {(latest.alerts || []).length === 0 && <div className="text-[var(--muted)]">All quiet.</div>}
                {(latest.alerts || []).map((a) => (
                  <div key={`${a.ts}-${a.message}`} className="flex items-start gap-2">
                    {a.kind === "stock" ? <Ban size={12} className="mt-1 text-[var(--amber)] shrink-0" /> : <BellRing size={12} className="mt-1 text-[var(--rose)] shrink-0" />}
                    <span className="text-xs">{a.message}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Revenue trend across snapshots */}
      {(report?.history || []).length > 1 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 mb-6" data-testid="trend-chart-card">
          <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)] mb-2">Revenue Trend (per snapshot)</div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={[...report.history].reverse().map((h) => ({ t: new Date(h.ts).toLocaleTimeString("en-HK", { hour12: false }), revenue: h.sales?.total_revenue || 0 }))}>
              <XAxis dataKey="t" stroke="#687087" fontSize={10} />
              <YAxis stroke="#687087" fontSize={10} />
              <Tooltip contentStyle={MIRROR_TOOLTIP_STYLE} />
              <Line type="monotone" dataKey="revenue" stroke="#00F2FE" strokeWidth={2} dot={MIRROR_DOT_STYLE} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {latest && (
        <>
          <h2 className="font-display font-bold text-xl mb-3">Inventory Snapshot</h2>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)] mb-6">
            {(latest.inventory || []).map((i) => (
              <div key={i.name} className="p-3 flex justify-between text-sm">
                <span>{i.name}</span>
                <span className={`font-mono font-bold ${i.qty <= i.par_level ? "text-[var(--rose)]" : "text-[var(--emerald)]"}`}>{i.qty}{i.unit}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="font-display font-bold text-xl mb-3">Sync History</h2>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
        {(report?.history || []).map((h) => (
          <div key={h.ts} className="p-3 flex justify-between text-sm font-mono">
            <span className="text-[var(--muted)]">{new Date(h.ts).toLocaleString()}</span>
            <span className="text-[var(--cyan)] font-bold">{fmtHKD(h.sales?.total_revenue)}</span>
          </div>
        ))}
        {!(report?.history || []).length && <div className="p-8 text-center text-[var(--muted)] text-sm">No snapshots yet — hit Sync Now</div>}
      </div>
    </div>
  );
}
