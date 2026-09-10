import { useEffect, useState, useCallback } from "react";
import { api, fmtHKD } from "@/lib/api";
import { toast } from "sonner";
import { Beer, RefreshCw, Ban, AlertTriangle, Plus, Trash2, TrendingUp, Pencil, DollarSign } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { errMsg } from "@/lib/errors";

const KEG_TOOLTIP_STYLE = { background: "#121824", border: "1px solid #26334D" };
const KEG_DOT_STYLE = { fill: "#00F2FE", r: 4 };
const POUR_PRESETS = [50, 100, 150, 250, 300, 400, 600];

export default function Kegs() {
  const [kegs, setKegs] = useState([]);
  const [products, setProducts] = useState([]);
  const [selKeg, setSelKeg] = useState(null);
  const [editor, setEditor] = useState(null); // {keg?} — open editor modal
  const [showVar, setShowVar] = useState(false);

  const load = useCallback(async () => {
    const [k, p] = await Promise.all([api.get("/kegs"), api.get("/products")]);
    setKegs(k.data); setProducts(p.data);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const install = async (k) => {
    if (!confirm(`Install fresh keg for ${k.name}? This resets volume + variance baseline.`)) return;
    await api.post(`/kegs/${k.id}/new`); toast.success("Fresh keg installed"); load();
  };
  const blown = async (k) => {
    if (!confirm(`Mark ${k.name} as blown? Variance will be recorded.`)) return;
    const r = await api.post(`/kegs/${k.id}/blown`);
    toast.error(`${k.name} blown · variance ${r.data.blown_variance_pct}%`); load();
  };
  const del = async (k) => {
    if (!confirm(`Delete keg ${k.name}?`)) return;
    try { await api.delete(`/kegs/${k.id}`); load(); } catch (e) { toast.error(errMsg(e, "Manager only")); }
  };

  const alerts = kegs.filter(k => k.alert).length;
  const blown_ = kegs.filter(k => k.status === "blown").length;
  const varianceRed = kegs.filter(k => k.variance_high).length;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <h1 className="font-display text-2xl font-black">Keg Watch · {kegs.length} taps</h1>
        <div className="ml-auto flex gap-2">
          <button data-testid="btn-variance-report" onClick={() => setShowVar(true)} className="px-4 py-2 rounded-lg text-xs uppercase flex items-center gap-2 bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--rose)] text-[var(--rose)]">
            <AlertTriangle size={14} /> Variance Report
          </button>
          <button data-testid="btn-add-keg" onClick={() => setEditor({})} className="btn-neon px-4 py-2 rounded-lg text-xs uppercase flex items-center gap-2">
            <Plus size={14} /> Add Keg
          </button>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-3 mb-4">
        <Kpi label="Total Taps" value={kegs.length} color="#00F2FE" testid="kegs-total" />
        <Kpi label="Alerts (<thr)" value={alerts} color="#F43F5E" testid="kegs-alerts" />
        <Kpi label="Variance >5%" value={varianceRed} color="#F43F5E" testid="kegs-variance" />
        <Kpi label="Blown" value={blown_} color="#94A3B8" testid="kegs-blown" />
        <Kpi label="On Tap" value={kegs.filter(k => k.status === "on").length} color="#10B981" testid="kegs-on" />
      </div>

      <div className="grid grid-cols-3 gap-3">
        {kegs.map(k => {
          const pct = k.pct_remaining || 0;
          const barColor = pct <= k.threshold_pct ? "#F43F5E" : pct < 30 ? "#FFB800" : "#10B981";
          const isBlown = k.status === "blown";
          return (
            <div key={k.id} data-testid={`keg-${k.name}`}
              className={`p-4 rounded-xl border ${isBlown ? "border-[var(--muted)]/30 bg-[var(--surface)] opacity-70"
                : k.alert ? "border-[var(--rose)] bg-[var(--rose)]/5 animate-pulse" : "border-[var(--border)] bg-[var(--surface)]"}`}>
              <div className="flex items-center gap-2">
                <Beer size={16} className="text-[var(--amber)]" />
                <div className="font-display font-bold text-white">{k.name}</div>
                {k.alert && <AlertTriangle size={14} className="ml-auto text-[var(--rose)]" />}
                {isBlown && <span className="ml-auto text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-[var(--rose)] text-white font-black">BLOWN</span>}
              </div>
              <div className="text-[10px] font-mono uppercase text-[var(--muted)] mt-1">{k.product?.name || "unlinked"}{k.supplier ? ` · ${k.supplier}` : ""}</div>

              <div className="mt-3">
                <div className="flex items-center justify-between text-[10px] font-mono">
                  <span className="text-[var(--muted)]">{Math.round((k.current_ml || 0) / 1000)}L / {Math.round(k.size_ml / 1000)}L</span>
                  <span data-testid={`keg-pct-${k.name}`} style={{ color: barColor }} className="font-bold">{pct}%</span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-[var(--surface-2)] overflow-hidden">
                  <div className="h-full transition-all" style={{ width: `${Math.max(2, pct)}%`, background: barColor }} />
                </div>
                <div className="text-[10px] font-mono text-[var(--muted)] mt-1">
                  {k.pours_remaining} pours left · {k.ml_per_pour}ml default pour
                </div>
              </div>

              {/* Cost + variance intelligence */}
              <div className="grid grid-cols-3 gap-1 mt-3 text-center">
                <MiniStat label="Cost" value={fmtHKD(k.cost || 0)} />
                <MiniStat label="Cost/Pour" value={fmtHKD(k.cost_per_pour || 0)} color="#FFB800" testid={`keg-cpp-${k.name}`} />
                <MiniStat label="Variance" value={`${k.variance_pct}%`} color={k.variance_high ? "#F43F5E" : "#10B981"} testid={`keg-var-${k.name}`} />
              </div>
              {k.variance_high && (
                <div data-testid={`keg-variance-flag-${k.name}`} className="mt-1 text-[10px] font-mono text-[var(--rose)] flex items-center gap-1">
                  <AlertTriangle size={10} /> Variance over 5% — check for overpour / spillage
                </div>
              )}

              <div className="grid grid-cols-4 gap-1 mt-3">
                <button data-testid={`keg-edit-${k.name}`} onClick={() => setEditor({ keg: k })}
                  className="py-1.5 rounded bg-[var(--surface-2)] border border-[var(--border)] text-[10px] font-mono uppercase text-[var(--cyan)] flex items-center justify-center gap-1"><Pencil size={10} /> Edit</button>
                <button data-testid={`keg-new-${k.name}`} onClick={() => install(k)}
                  className="py-1.5 rounded bg-[var(--surface-2)] border border-[var(--border)] text-[10px] font-mono uppercase text-[var(--emerald)] flex items-center justify-center gap-1"><RefreshCw size={10} /> New</button>
                <button data-testid={`keg-blown-${k.name}`} onClick={() => blown(k)} disabled={isBlown}
                  className="py-1.5 rounded bg-[var(--surface-2)] border border-[var(--border)] text-[10px] font-mono uppercase text-[var(--rose)] disabled:opacity-40 flex items-center justify-center gap-1"><Ban size={10} /> Blown</button>
                <button data-testid={`keg-del-${k.name}`} onClick={() => del(k)}
                  className="py-1.5 rounded bg-[var(--surface-2)] border border-[var(--border)] text-[10px] font-mono uppercase text-[var(--muted)] flex items-center justify-center gap-1"><Trash2 size={10} /> Del</button>
              </div>
              <button data-testid={`keg-chart-${k.name}`} onClick={() => setSelKeg(k)}
                className="mt-2 w-full py-1.5 rounded bg-[var(--cyan)]/10 border border-[var(--cyan)]/40 text-[10px] font-mono uppercase text-[var(--cyan)] flex items-center justify-center gap-1"><TrendingUp size={10} /> 7-day velocity</button>
            </div>
          );
        })}
        {kegs.length === 0 && (
          <div className="col-span-3 p-10 rounded-xl border border-dashed border-[var(--border)] text-center text-[var(--muted)]">No kegs yet — add your first tap.</div>
        )}
      </div>

      {selKeg && <KegAnalyticsModal keg={selKeg} onClose={() => setSelKeg(null)} />}
      {editor && <KegEditor init={editor.keg} products={products} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); load(); }} />}
      {showVar && <VarianceModal onClose={() => setShowVar(false)} />}
    </div>
  );
}

function VarianceModal({ onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.get("/kegs/variance-report", { params: { days: 7 } }).then(r => setData(r.data)).catch(e => setErr(errMsg(e, "Manager only")));
  }, []);
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl w-full max-w-3xl p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle size={18} className="text-[var(--rose)]" />
          <div className="font-display font-black text-xl">Keg Variance Report</div>
          <button onClick={onClose} className="ml-auto text-[var(--muted)] hover:text-white">×</button>
        </div>
        <div className="text-xs font-mono uppercase text-[var(--muted)] mb-4">Last 7 days · theoretical vs actual pours · red = overpour/spillage &gt;5%</div>
        {err && <div className="text-[var(--rose)] text-sm py-6 text-center">{err}</div>}
        {data && (
          <>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <Kpi label="Blown (7d)" value={data.blown_count} color="#94A3B8" testid="var-blown" />
              <Kpi label="High Variance" value={data.high_variance_count} color="#F43F5E" testid="var-high" />
              <Kpi label="Est. Loss" value={fmtHKD(data.total_est_loss)} color="#FFB800" testid="var-loss" />
            </div>
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-[var(--muted)] uppercase text-[10px] border-b border-[var(--border)]">
                  <th className="text-left py-1.5">Keg</th><th className="text-left">Beer</th>
                  <th className="text-right">Theo</th><th className="text-right">Actual</th>
                  <th className="text-right">Variance</th><th className="text-right">Est. Loss</th>
                </tr>
              </thead>
              <tbody>
                {data.kegs.map(k => (
                  <tr key={k.id} data-testid={`var-row-${k.name}`} className="border-b border-[var(--border)]/50">
                    <td className="py-1.5">{k.name}{k.status === "blown" ? " · BLOWN" : ""}</td>
                    <td className="text-[var(--muted)]">{k.product}</td>
                    <td className="text-right">{k.theoretical_pours}</td>
                    <td className="text-right">{k.actual_pours}</td>
                    <td className="text-right font-bold" style={{ color: k.variance_high ? "#F43F5E" : "#10B981" }}>{k.variance_pct}%</td>
                    <td className="text-right text-[var(--amber)]">{fmtHKD(k.est_loss)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

function KegEditor({ init, products, onClose, onSaved }) {
  const beers = products.filter(p => p.kind === "drink");
  const [f, setF] = useState({
    name: init?.name || "",
    product_id: init?.product_id || (beers[0]?.id || ""),
    size_ml: init?.size_ml || 30000,
    ml_per_pour: init?.ml_per_pour || 568,
    threshold_pct: init?.threshold_pct ?? 10,
    cost: init?.cost || 0,
    supplier: init?.supplier || "",
    purchase_date: init?.purchase_date || "",
    install_date: init?.install_date || "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));

  const save = async () => {
    if (!f.name || !f.product_id) return toast.error("Name + product required");
    setBusy(true);
    const body = { ...f, size_ml: +f.size_ml, ml_per_pour: +f.ml_per_pour, threshold_pct: +f.threshold_pct, cost: +f.cost,
      purchase_date: f.purchase_date || null, install_date: f.install_date || null };
    try {
      if (init) await api.patch(`/kegs/${init.id}`, body);
      else await api.post("/kegs", body);
      toast.success(init ? "Keg updated" : "Keg added"); onSaved();
    } catch (e) { toast.error(errMsg(e, "Save failed (manager only for cost)")); } finally { setBusy(false); }
  };

  const theo = f.ml_per_pour ? Math.floor(f.size_ml / f.ml_per_pour) : 0;
  const cpp = theo ? (f.cost / theo) : 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
        <div className="font-display font-black text-xl mb-4 flex items-center gap-2"><Beer size={18} className="text-[var(--amber)]" /> {init ? "Edit Keg" : "New Keg"}</div>
        <div className="space-y-3">
          <Field label="Tap name"><input data-testid="keg-f-name" value={f.name} onChange={e => set("name", e.target.value)} className="inp" /></Field>
          <Field label="Beer product">
            <select data-testid="keg-f-product" value={f.product_id} onChange={e => set("product_id", e.target.value)} className="inp">
              {beers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Keg size (ml)"><input data-testid="keg-f-size" type="number" value={f.size_ml} onChange={e => set("size_ml", e.target.value)} className="inp" /></Field>
            <Field label="Low threshold %"><input data-testid="keg-f-thr" type="number" value={f.threshold_pct} onChange={e => set("threshold_pct", e.target.value)} className="inp" /></Field>
          </div>

          {/* Pour preset picker */}
          <Field label="Default pour size (ml)">
            <div className="flex flex-wrap gap-1.5 mb-2">
              {POUR_PRESETS.map(ml => (
                <button key={ml} data-testid={`keg-pour-${ml}`} onClick={() => set("ml_per_pour", ml)}
                  className={`px-2.5 py-1 rounded text-xs font-mono border ${+f.ml_per_pour === ml ? "bg-[var(--cyan)] text-black border-transparent" : "bg-[var(--surface-2)] text-[var(--muted)] border-[var(--border)]"}`}>{ml}</button>
              ))}
            </div>
            <input data-testid="keg-f-pour" type="number" value={f.ml_per_pour} onChange={e => set("ml_per_pour", e.target.value)} placeholder="Custom ml" className="inp" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Keg cost (HK$)"><input data-testid="keg-f-cost" type="number" value={f.cost} onChange={e => set("cost", e.target.value)} className="inp" /></Field>
            <Field label="Supplier"><input data-testid="keg-f-supplier" value={f.supplier} onChange={e => set("supplier", e.target.value)} className="inp" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Purchase date"><input data-testid="keg-f-purchase" type="date" value={(f.purchase_date || "").slice(0, 10)} onChange={e => set("purchase_date", e.target.value)} className="inp" /></Field>
            <Field label="Install date"><input data-testid="keg-f-install" type="date" value={(f.install_date || "").slice(0, 10)} onChange={e => set("install_date", e.target.value)} className="inp" /></Field>
          </div>

          <div className="p-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] text-xs font-mono flex items-center justify-between">
            <span className="text-[var(--muted)]">{theo} theoretical pours</span>
            <span className="text-[var(--amber)] flex items-center gap-1"><DollarSign size={12} /> {fmtHKD(cpp)}/pour</span>
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-lg bg-[var(--surface-2)]">Cancel</button>
          <button data-testid="keg-f-save" onClick={save} disabled={busy} className="flex-1 btn-neon py-2.5 rounded-lg disabled:opacity-40">Save</button>
        </div>
      </div>
    </div>
  );
}

function KegAnalyticsModal({ keg, onClose }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.get(`/kegs/${keg.id}/pours`, { params: { days: 7 } }).then(r => setData(r.data)); }, [keg.id]);
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl w-full max-w-2xl p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1">
          <TrendingUp size={18} className="text-[var(--cyan)]" />
          <div className="font-display font-black text-xl">{keg.name}</div>
          <button onClick={onClose} className="ml-auto text-[var(--muted)] hover:text-white">×</button>
        </div>
        <div className="text-xs font-mono uppercase text-[var(--muted)] mb-4">7-day pour velocity</div>
        {data && (
          <>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <div className="p-2 rounded bg-[var(--surface-2)] border border-[var(--border)]"><div className="text-[10px] font-mono uppercase text-[var(--muted)]">Total (7d)</div><div className="font-display font-black text-xl text-[var(--cyan)]" data-testid="keg-total-ml">{data.total_pints} pints</div></div>
              <div className="p-2 rounded bg-[var(--surface-2)] border border-[var(--border)]"><div className="text-[10px] font-mono uppercase text-[var(--muted)]">Daily avg</div><div className="font-display font-black text-xl">{(data.total_pints / 7).toFixed(1)}</div></div>
              <div className="p-2 rounded bg-[var(--surface-2)] border border-[var(--border)]"><div className="text-[10px] font-mono uppercase text-[var(--muted)]">Peak day</div><div className="font-display font-black text-xl">{Math.max(0, ...data.days.map(d => d.pints))} pints</div></div>
            </div>
            <div data-testid="keg-chart">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={data.days}>
                  <XAxis dataKey="day" stroke="#94A3B8" fontSize={10} tickFormatter={(d) => d.slice(5)} />
                  <YAxis stroke="#94A3B8" fontSize={10} />
                  <Tooltip contentStyle={KEG_TOOLTIP_STYLE} formatter={(v) => [`${(v / 568).toFixed(1)} pints`, "Pours"]} />
                  <Line type="monotone" dataKey="ml" stroke="#00F2FE" strokeWidth={2} dot={KEG_DOT_STYLE} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const Kpi = ({ label, value, color, testid }) => (
  <div data-testid={testid} className="p-3 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
    <div className="text-[10px] font-mono uppercase text-[var(--muted)]">{label}</div>
    <div className="font-display font-black text-2xl mt-1" style={{ color }}>{value}</div>
  </div>
);
const MiniStat = ({ label, value, color = "#94A3B8", testid }) => (
  <div data-testid={testid} className="p-1.5 rounded bg-[var(--surface-2)] border border-[var(--border)]">
    <div className="text-[8px] font-mono uppercase text-[var(--muted)]">{label}</div>
    <div className="font-mono font-bold text-xs mt-0.5" style={{ color }}>{value}</div>
  </div>
);
const Field = ({ label, children }) => (
  <div>
    <label className="text-[10px] font-mono uppercase text-[var(--muted)] block mb-1">{label}</label>
    {children}
  </div>
);
