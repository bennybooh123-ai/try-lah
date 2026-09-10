import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Printer, RotateCcw, Wifi, WifiOff, BellRing, Plus } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

const ROLE_COLORS = { bar: "var(--amber)", kitchen: "var(--rose)", receipt: "var(--emerald)", mixed: "var(--purple)" };

export default function Printers() {
  const [printers, setPrinters] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const { user } = useAuth();
  const mgr = ["owner", "admin", "manager", "assistant_manager"].includes(user?.role);

  const load = useCallback(async () => {
    const [p, j, a] = await Promise.all([api.get("/printers"), api.get("/print-jobs"), api.get("/alerts")]);
    setPrinters(p.data); setJobs(j.data); setAlerts(a.data.filter((x) => !x.ack));
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);

  const toggleOnline = async (p) => {
    await api.patch(`/printers/${p.id}`, { online: !p.online });
    toast.success(`${p.name} ${!p.online ? "back ONLINE" : "set OFFLINE (simulated outage)"}`);
    load();
  };

  const retry = async (j) => {
    const r = await api.post(`/print-jobs/${j.id}/retry`);
    r.data.status === "printed" ? toast.success(`Reprinted on ${j.printer_name}`) : toast.error("Retry failed — printer still offline");
    load();
  };

  const addPrinter = async () => {
    const name = prompt("Printer name"); if (!name) return;
    const ip = prompt("Static LAN IP", "192.168.1.110");
    const role = prompt("Role: bar | kitchen | receipt | mixed", "bar");
    await api.post("/printers", { name, ip, role });
    toast.success("Printer added"); load();
  };

  return (
    <div data-testid="print-job-monitor">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="font-display font-black text-3xl">Printers</h1>
          <p className="text-xs font-mono text-[var(--muted)] uppercase tracking-widest mt-1">ESC/POS · static LAN IPs · simulation mode until hardware lands</p>
        </div>
        {mgr && <button data-testid="add-printer-btn" onClick={addPrinter} className="btn-neon px-4 py-2 rounded-lg flex items-center gap-2"><Plus size={16} /> Printer</button>}
      </div>

      {alerts.length > 0 && (
        <div className="mb-4 rounded-xl border border-[var(--rose)]/50 bg-[var(--rose)]/5 p-4" data-testid="alerts-panel">
          <div className="flex items-center gap-2 text-[var(--rose)] font-bold text-sm mb-2"><BellRing size={16} /> Active Alerts ({alerts.length}) — a failed print is a lost order</div>
          {alerts.slice(0, 6).map((a) => (
            <div key={a.id} data-testid={`alert-${a.id}`} className="flex justify-between items-center py-1.5 text-sm border-b border-[var(--border)] last:border-0">
              <span>{a.message}</span>
              <button data-testid={`ack-alert-${a.id}`} onClick={async () => { await api.post(`/alerts/${a.id}/ack`); load(); }}
                className="px-3 py-1 rounded-md bg-[var(--surface-2)] text-xs">Ack</button>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {printers.map((p) => (
          <div key={p.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" data-testid={`printer-${p.id}`}>
            <div className="flex justify-between items-start">
              <div className="flex items-center gap-2">
                <Printer size={18} style={{ color: ROLE_COLORS[p.role] }} />
                <div>
                  <div className="font-semibold text-sm">{p.name}</div>
                  <div className="text-xs font-mono text-[var(--muted)]">{p.ip}:{p.port} · {p.role}</div>
                </div>
              </div>
              {mgr && (
                <button data-testid={`toggle-printer-${p.id}`} onClick={() => toggleOnline(p)}
                  className={`px-2.5 py-1 rounded-full text-[10px] font-mono font-bold uppercase flex items-center gap-1 ${
                    p.online ? "bg-[var(--emerald)]/15 text-[var(--emerald)]" : "bg-[var(--rose)]/15 text-[var(--rose)]"}`}>
                  {p.online ? <Wifi size={11} /> : <WifiOff size={11} />}{p.online ? "Online" : "Offline"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <h2 className="font-display font-bold text-xl mb-3">Print Queue</h2>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
        {jobs.map((j) => (
          <div key={j.id} data-testid={`print-job-${j.id}`} className="p-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm">{j.printer_name}</span>
                <span className="px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase"
                  style={{ background: `${ROLE_COLORS[j.role]}22`, color: ROLE_COLORS[j.role] }}>{j.role}</span>
                <span data-testid={`job-status-${j.id}`} className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${
                  j.status === "printed" ? "bg-[var(--emerald)]/15 text-[var(--emerald)]" : "bg-[var(--rose)]/15 text-[var(--rose)]"}`}>{j.status}</span>
                <span className="text-[10px] font-mono text-[var(--muted)]">{j.table}</span>
              </div>
              <pre className="text-[11px] font-mono text-[var(--muted)] mt-1 whitespace-pre-wrap truncate max-w-xl">{j.content}</pre>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-xs font-mono text-[var(--muted)]">×{j.attempts}</span>
              {j.status === "failed" && (
                <button data-testid={`retry-job-${j.id}`} onClick={() => retry(j)}
                  className="px-3 py-1.5 rounded-lg bg-[var(--rose)]/15 text-[var(--rose)] text-xs font-bold flex items-center gap-1">
                  <RotateCcw size={12} /> Retry</button>
              )}
            </div>
          </div>
        ))}
        {jobs.length === 0 && <div className="p-8 text-center text-[var(--muted)] text-sm">No print jobs yet — fire a course or pay a bill</div>}
      </div>
    </div>
  );
}
