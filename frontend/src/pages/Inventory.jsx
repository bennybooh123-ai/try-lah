import { useEffect, useState, useCallback, useMemo } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { PackagePlus, Trash2, AlertTriangle, Plus } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

export default function Inventory() {
  const [ings, setIngs] = useState([]);
  const [moves, setMoves] = useState([]);
  const [usage, setUsage] = useState([]);
  const [buy, setBuy] = useState([]);
  const [counts, setCounts] = useState({});
  const [countResult, setCountResult] = useState(null);
  const [tab, setTab] = useState("stock");
  const { user } = useAuth();
  const mgr = ["owner", "admin", "manager", "assistant_manager"].includes(user?.role);

  const load = useCallback(async () => {
    const [i, m, u, b] = await Promise.all([
      api.get("/ingredients"), api.get("/inventory/movements?limit=40"),
      api.get("/inventory/usage"), api.get("/inventory/purchase-suggestions"),
    ]);
    setIngs(i.data); setMoves(m.data); setUsage(u.data); setBuy(b.data);
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (ing, type) => {
    const qty = parseFloat(prompt(`${type === "restock" ? "Restock" : "Wastage"} qty (${ing.unit})`));
    if (!qty || qty <= 0) return;
    const extra = type === "wastage" ? { reason: prompt("Reason", "spillage") || "" } : { note: prompt("Note", "supplier delivery") || "" };
    await api.post(`/ingredients/${ing.id}/${type}`, { qty, ...extra });
    toast.success(`${type === "restock" ? "Restocked" : "Wastage logged"}: ${ing.name} ${qty}${ing.unit}`);
    load();
  };

  const addIng = async () => {
    const name = prompt("Ingredient name"); if (!name) return;
    const unit = prompt("Unit (ml / g / pcs)", "ml");
    const qty = parseFloat(prompt("Opening qty", "0") || "0");
    const par = parseFloat(prompt("Par level (low-stock threshold)", "0") || "0");
    await api.post("/ingredients", { name, unit, qty, par_level: par });
    toast.success("Ingredient added"); load();
  };

  const lowCount = ings.filter((i) => i.low).length;
  const buyTotal = useMemo(() => buy.reduce((a, b) => a + b.est_cost, 0), [buy]);

  return (
    <div data-testid="inventory-management-panel">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="font-display font-black text-3xl">Inventory</h1>
          <p className="text-xs font-mono text-[var(--muted)] uppercase tracking-widest mt-1">
            auto-deduct on paid sale · log every restock & spill or counts drift
            {lowCount > 0 && <span className="ml-2 px-2 py-0.5 rounded-full bg-[var(--rose)]/15 text-[var(--rose)] font-bold" data-testid="low-stock-count">{lowCount} LOW</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <div className="flex gap-1 p-1 bg-[var(--surface-2)] rounded-lg">
            {[["stock", "Stock"], ["moves", "Log"], ["usage", "Usage"], ["count", "Spot Count"], ["buy", "Order"]].map(([k, l]) => (
              <button key={k} data-testid={`inv-tab-${k}`} onClick={() => setTab(k)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold ${tab === k ? "bg-[var(--cyan)] text-black" : "text-[var(--muted)]"}`}>{l}</button>
            ))}
          </div>
          {mgr && <button data-testid="add-ingredient-btn" onClick={addIng} className="btn-neon px-4 py-2 rounded-lg flex items-center gap-2"><Plus size={16} /> Ingredient</button>}
        </div>
      </div>

      {tab === "stock" && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
          {ings.map((i) => (
            <div key={i.id} data-testid={`ingredient-${i.id}`} className="p-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{i.name}</span>
                  {i.low && <span className="px-2 py-0.5 rounded-full bg-[var(--rose)]/15 text-[var(--rose)] text-[9px] font-mono font-bold uppercase flex items-center gap-1" data-testid={`low-badge-${i.id}`}><AlertTriangle size={10} /> Low</span>}
                </div>
                <div className="text-xs font-mono text-[var(--muted)]">par {i.par_level}{i.unit}</div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className={`font-mono font-bold text-lg ${i.low ? "text-[var(--rose)]" : ""}`} data-testid={`ing-qty-${i.id}`}>
                  {i.qty}<span className="text-xs text-[var(--muted)] ml-0.5">{i.unit}</span>
                </span>
                <button data-testid={`restock-${i.id}`} onClick={() => act(i, "restock")}
                  className="px-3 py-1.5 rounded-lg bg-[var(--surface-2)] text-xs font-bold flex items-center gap-1"><PackagePlus size={12} /> Restock</button>
                <button data-testid={`wastage-${i.id}`} onClick={() => act(i, "wastage")}
                  className="px-3 py-1.5 rounded-lg bg-[var(--rose)]/15 text-[var(--rose)] text-xs font-bold flex items-center gap-1"><Trash2 size={12} /> Wastage</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "moves" && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
          {moves.map((m) => (
            <div key={m.id} className="p-3 flex justify-between text-sm">
              <span>{m.name} <span className="text-[var(--muted)] text-xs">· {m.type} · {m.by}{m.ref ? ` · ${String(m.ref).slice(0, 20)}` : ""}</span></span>
              <span className={`font-mono font-bold ${m.delta < 0 ? "text-[var(--rose)]" : "text-[var(--emerald)]"}`}>{m.delta > 0 ? "+" : ""}{m.delta}</span>
            </div>
          ))}
          {moves.length === 0 && <div className="p-8 text-center text-[var(--muted)] text-sm">No movements yet</div>}
        </div>
      )}

      {tab === "usage" && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
          <div className="p-3 grid grid-cols-3 text-[10px] font-mono uppercase tracking-widest text-[var(--muted)]"><span>Ingredient</span><span>Sold</span><span>Wasted</span></div>
          {usage.map((u) => (
            <div key={u.ingredient_id} className="p-3 grid grid-cols-3 text-sm">
              <span className="font-medium">{u.name}</span>
              <span className="font-mono text-[var(--amber)]">{u.sold}</span>
              <span className="font-mono text-[var(--rose)]">{u.wasted}</span>
            </div>
          ))}
          {usage.length === 0 && <div className="p-8 text-center text-[var(--muted)] text-sm">No usage yet — pay a sale first</div>}
        </div>
      )}
      {tab === "count" && (
        <div data-testid="spot-count-panel">
          <p className="text-xs text-[var(--muted)] mb-3">Weekly spot count — enter the physical count; variance posts as a count adjustment.</p>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
            {ings.map((i) => (
              <div key={i.id} className="p-3 flex items-center gap-3 text-sm" data-testid={`count-row-${i.id}`}>
                <span className="font-medium flex-1">{i.name}</span>
                <span className="font-mono text-[var(--muted)] text-xs">system {i.qty}{i.unit}</span>
                <input data-testid={`count-input-${i.id}`} type="number" placeholder="counted"
                  value={counts[i.id] ?? ""} onChange={(e) => setCounts((c) => ({ ...c, [i.id]: e.target.value }))}
                  className="w-24 px-2 py-1.5 rounded bg-[var(--surface-2)] border border-[var(--border)] font-mono text-sm" />
              </div>
            ))}
          </div>
          <button data-testid="submit-spot-count" className="btn-neon px-5 py-2.5 rounded-lg mt-4"
            onClick={async () => {
              const payload = Object.entries(counts).filter(([, v]) => v !== "").map(([ingredient_id, v]) => ({ ingredient_id, counted: parseFloat(v) }));
              if (!payload.length) return toast.error("Enter at least one count");
              const r = await api.post("/inventory/spot-count", { counts: payload, note: "weekly count" });
              setCountResult(r.data.variances.filter((v) => Math.abs(v.variance) > 1e-9));
              setCounts({});
              toast.success(`Count saved — ${r.data.total_variance_items} variance(s)`);
              load();
            }}>Submit Count</button>
          {countResult && (
            <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]" data-testid="variance-report">
              <div className="p-3 text-[10px] font-mono uppercase tracking-widest text-[var(--muted)]">Variance report</div>
              {countResult.length === 0 && <div className="p-3 text-sm text-[var(--emerald)]">All counts matched. Trust intact.</div>}
              {countResult.map((v) => (
                <div key={v.ingredient_id} className="p-3 flex justify-between text-sm">
                  <span>{v.name} <span className="text-xs text-[var(--muted)]">expected {v.expected} → counted {v.counted}</span></span>
                  <span className={`font-mono font-bold ${v.variance < 0 ? "text-[var(--rose)]" : "text-[var(--emerald)]"}`}>{v.variance > 0 ? "+" : ""}{v.variance}{v.unit}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "buy" && (
        <div data-testid="purchase-suggestions-panel">
          <p className="text-xs text-[var(--muted)] mb-3">Suggested restock = par × 2 − on hand, sorted by estimated cost.</p>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
            <div className="p-3 grid grid-cols-5 text-[10px] font-mono uppercase tracking-widest text-[var(--muted)]">
              <span>Ingredient</span><span>On hand</span><span>Par</span><span>Buy</span><span className="text-right">Est. cost</span>
            </div>
            {buy.map((b) => (
              <div key={b.ingredient_id} className="p-3 grid grid-cols-5 text-sm items-center" data-testid={`buy-${b.ingredient_id}`}>
                <span className="font-medium">{b.name}</span>
                <span className="font-mono text-[var(--rose)]">{b.on_hand}{b.unit}</span>
                <span className="font-mono text-[var(--muted)]">{b.par_level}{b.unit}</span>
                <span className="font-mono font-bold text-[var(--amber)]">{b.suggested_qty}{b.unit}</span>
                <span className="font-mono font-bold text-right">HK${b.est_cost.toFixed(2)}</span>
              </div>
            ))}
            {buy.length > 0 && (
              <div className="p-3 flex justify-between font-mono font-bold" data-testid="buy-total">
                <span>Total order</span>
                <span className="text-[var(--amber)]">HK${buyTotal.toFixed(2)}</span>
              </div>
            )}
            {buy.length === 0 && <div className="p-8 text-center text-[var(--emerald)] text-sm">Stock healthy — nothing to order.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
