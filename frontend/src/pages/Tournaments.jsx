import { useEffect, useState, useCallback } from "react";
import { api, fmtHKD } from "@/lib/api";
import { toast } from "sonner";
import { Trophy, Plus, X, Banknote, Medal } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

export default function Tournaments() {
  const [list, setList] = useState([]);
  const [sel, setSel] = useState(null);
  const { user } = useAuth();
  const mgr = ["owner", "admin", "manager", "assistant_manager"].includes(user?.role);

  const selId = sel?.id;
  const load = useCallback(async () => {
    setList((await api.get("/tournaments")).data);
    if (selId) setSel((await api.get(`/tournaments/${selId}`)).data);
  }, [selId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const create = async () => {
    const name = prompt("Tournament name", "Wednesday Darts 501"); if (!name) return;
    const entry_fee = parseFloat(prompt("Entry fee HK$", "50") || "50");
    const date = prompt("Date (YYYY-MM-DD)", new Date().toISOString().slice(0, 10));
    const r = await api.post("/tournaments", { name, entry_fee, date });
    toast.success("Tournament created"); load(); setSel(r.data);
  };

  const addPlayer = async () => {
    const name = prompt("Player name"); if (!name) return;
    await api.post(`/tournaments/${sel.id}/players`, { name });
    toast.success(`${name} signed up`); load();
  };

  const collect = async (p) => {
    const method = prompt("Method: cash / octopus / fps", "cash") || "cash";
    try {
      await api.post(`/tournaments/${sel.id}/collect`, { player_id: p.id, method });
      toast.success(`Collected ${fmtHKD(sel.entry_fee)} from ${p.name}`); load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed"); }
  };

  const payout = async () => {
    const recipient = prompt("Recipient (winner name)"); if (!recipient) return;
    const place = prompt("Place (1st / 2nd / …)", "1st");
    const amount = parseFloat(prompt("Amount HK$", String(sel.ledger.prize_pool * 0.6)) || "0");
    try {
      await api.post(`/tournaments/${sel.id}/payouts`, { recipient, place, amount });
      toast.success(`Paid ${fmtHKD(amount)} to ${recipient}`); load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed"); }
  };

  return (
    <div data-testid="tournaments-page">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="font-display font-black text-3xl">Darts Tournaments</h1>
          <p className="text-xs font-mono text-[var(--muted)] uppercase tracking-widest mt-1">Sign-ups · entry fees · prize pool · audited payouts</p>
        </div>
        {mgr && <button data-testid="new-tournament-btn" onClick={create} className="btn-neon px-4 py-2 rounded-lg flex items-center gap-2"><Plus size={16} /> Tournament</button>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="space-y-2">
          {list.map((t) => (
            <button key={t.id} data-testid={`tournament-${t.id}`}
              onClick={async () => setSel((await api.get(`/tournaments/${t.id}`)).data)}
              className={`w-full text-left p-4 rounded-xl border transition-colors ${sel?.id === t.id ? "border-[var(--cyan)] bg-[var(--surface-2)]" : "border-[var(--border)] bg-[var(--surface)]"}`}>
              <div className="flex items-center gap-2">
                <Trophy size={16} className="text-[var(--amber)]" />
                <span className="font-semibold text-sm flex-1">{t.name}</span>
                <span className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${t.status === "open" ? "bg-[var(--emerald)]/15 text-[var(--emerald)]" : "bg-[var(--surface-2)] text-[var(--muted)]"}`}>{t.status}</span>
              </div>
              <div className="text-xs font-mono text-[var(--muted)] mt-1">{t.date} · {t.game} · {fmtHKD(t.entry_fee)} entry</div>
            </button>
          ))}
          {list.length === 0 && <div className="text-center text-[var(--muted)] text-sm py-12">No tournaments yet</div>}
        </div>

        {sel && (
          <div className="lg:col-span-2 space-y-4" data-testid="tournament-detail">
            <div className="grid grid-cols-4 gap-3">
              {[["Players", sel.ledger.players, ""], ["Collected", fmtHKD(sel.ledger.collected), "text-[var(--emerald)]"],
                ["Paid out", fmtHKD(sel.ledger.paid_out), "text-[var(--rose)]"], ["Pool balance", fmtHKD(sel.ledger.balance), "text-[var(--amber)]"]].map(([l, v, c]) => (
                <div key={l} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)]">{l}</div>
                  <div className={`font-display font-black text-xl ${c}`} data-testid={`ledger-${l.toLowerCase().replace(/\s/g, "-")}`}>{v}</div>
                </div>
              ))}
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="p-3 flex items-center justify-between border-b border-[var(--border)]">
                <span className="font-mono text-xs uppercase tracking-widest text-[var(--muted)]">Players ({sel.players.length})</span>
                <button data-testid="add-player-btn" onClick={addPlayer} className="btn-neon px-3 py-1.5 rounded-lg text-xs flex items-center gap-1"><Plus size={12} /> Sign up</button>
              </div>
              <div className="divide-y divide-[var(--border)]">
                {sel.players.map((p) => (
                  <div key={p.id} className="p-3 flex items-center gap-3 text-sm" data-testid={`player-${p.id}`}>
                    <span className="flex-1 font-medium">{p.name}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${p.paid ? "bg-[var(--emerald)]/15 text-[var(--emerald)]" : "bg-[var(--amber)]/15 text-[var(--amber)]"}`} data-testid={`player-paid-${p.id}`}>
                      {p.paid ? "PAID" : "OWED"}
                    </span>
                    {!p.paid && <button data-testid={`collect-${p.id}`} onClick={() => collect(p)} className="px-3 py-1.5 rounded-lg bg-[var(--emerald)]/15 text-[var(--emerald)] text-xs font-bold flex items-center gap-1"><Banknote size={12} /> Collect</button>}
                    {mgr && <button data-testid={`remove-player-${p.id}`} onClick={async () => { await api.delete(`/tournaments/${sel.id}/players/${p.id}`); load(); }} className="text-[var(--rose)]"><X size={14} /></button>}
                  </div>
                ))}
                {sel.players.length === 0 && <div className="p-6 text-center text-[var(--muted)] text-sm">No players signed up</div>}
              </div>
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="p-3 flex items-center justify-between border-b border-[var(--border)]">
                <span className="font-mono text-xs uppercase tracking-widest text-[var(--muted)]">Ledger (audited)</span>
                {mgr && sel.status === "open" && (
                  <div className="flex gap-2">
                    <button data-testid="payout-btn" onClick={payout} className="px-3 py-1.5 rounded-lg bg-[var(--amber)]/15 text-[var(--amber)] text-xs font-bold flex items-center gap-1"><Medal size={12} /> Payout</button>
                    <button data-testid="close-tournament-btn" onClick={async () => { await api.post(`/tournaments/${sel.id}/close`); toast.success("Tournament closed"); load(); }} className="px-3 py-1.5 rounded-lg bg-[var(--surface-2)] text-xs">Close</button>
                  </div>
                )}
              </div>
              <div className="divide-y divide-[var(--border)]">
                {sel.transactions.map((tx) => (
                  <div key={tx.id} className="p-3 flex justify-between text-sm" data-testid={`tx-${tx.id}`}>
                    <span>{tx.type === "entry_fee" ? `Entry — ${tx.player}` : `Prize ${tx.place} — ${tx.recipient}`}
                      <span className="text-[10px] font-mono text-[var(--muted)] ml-2">{tx.method} · {tx.recorded_by}</span></span>
                    <span className={`font-mono font-bold ${tx.type === "payout" ? "text-[var(--rose)]" : "text-[var(--emerald)]"}`}>
                      {tx.type === "payout" ? "-" : "+"}{fmtHKD(tx.amount)}
                    </span>
                  </div>
                ))}
                {sel.transactions.length === 0 && <div className="p-6 text-center text-[var(--muted)] text-sm">No transactions yet</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
