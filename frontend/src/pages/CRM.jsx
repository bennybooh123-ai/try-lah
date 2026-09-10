import { useEffect, useState } from "react";
import { api, fmtHKD } from "@/lib/api";
import { toast } from "sonner";
import { Plus, Search, Crown, TrendingUp, Printer, Coins, Wallet, Gift, Pencil, Percent, Settings } from "lucide-react";
import Receipt from "@/components/pos/Receipt";
import ManagerPin from "@/components/pos/ManagerPin";
import { openPrintableWindow } from "@/lib/printable";
import { useAuth } from "@/context/AuthContext";
import { errMsg } from "@/lib/errors";

const TIER_COLOR = { VIP: "#F43F5E", Gold: "#FFB800", Silver: "#94A3B8", Regular: "#26334D" };
const MANAGER = ["owner", "admin", "manager", "assistant_manager"];

export default function CRM() {
  const { user } = useAuth();
  const isManager = MANAGER.includes(user?.role);
  const [members, setMembers] = useState([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [pinGate, setPinGate] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [editing, setEditing] = useState(false);

  const load = async (query = "") => {
    const r = await api.get("/members", { params: query ? { q: query } : {} });
    setMembers(r.data);
  };
  useEffect(() => { load(); api.get("/loyalty/config").then(r => setCfg(r.data)).catch(() => {}); }, []);

  const openMember = async (m) => {
    const { data } = await api.get(`/members/${m.id}`);
    setSel(data); setEditing(false);
  };
  const refresh = async () => { if (sel) { const { data } = await api.get(`/members/${sel.member.id}`); setSel(data); } load(q); };

  // Run a money-adjacent action; managers act directly, others get PIN-gated.
  const gate = (action, run) => {
    if (isManager) return run(undefined);
    setPinGate({ action, run });
  };

  const addMember = async () => {
    const name = prompt("Member name?"); if (!name) return;
    const phone = prompt("Phone?"); if (!phone) return;
    const tier = prompt("Tier (Regular/Silver/Gold/VIP)?", "Regular") || "Regular";
    try { await api.post("/members", { name, phone, tier }); toast.success("Member added"); load(); }
    catch (e) { toast.error(errMsg(e, "Failed")); }
  };

  const adjust = (field) => {
    const label = field === "points" ? "points (+/-)" : "credit HK$ (+/-)";
    const val = prompt(`Adjust ${label}`); if (val === null) return;
    const delta = parseFloat(val); if (Number.isNaN(delta)) return toast.error("Bad number");
    const reason = prompt("Reason (audited)", "manager adjustment") || "";
    gate(`adjust ${field}`, async (pin) => {
      try {
        await api.post(`/members/${sel.member.id}/adjust`, { field, delta, reason, manager_pin: pin });
        toast.success(`${field} adjusted`); refresh();
      } catch (e) { toast.error(errMsg(e, "Failed")); }
    });
  };

  const setDiscount = () => {
    const val = prompt("Member discount %", String(sel.member.member_discount_pct || 0)); if (val === null) return;
    const pct = parseFloat(val); if (Number.isNaN(pct)) return;
    gate("set member discount", async (pin) => {
      try {
        await api.post(`/members/${sel.member.id}/adjust`, { field: "member_discount_pct", set_value: pct, reason: "set discount", manager_pin: pin });
        toast.success("Discount set"); refresh();
      } catch (e) { toast.error(errMsg(e, "Failed")); }
    });
  };

  const redeem = () => {
    const cost = cfg?.coupon_points_cost || 100, value = cfg?.coupon_value || 10;
    const val = prompt(`Redeem points (multiples of ${cost} = HK$${value} credit each). Available: ${sel.member.points}`, String(cost));
    if (val === null) return;
    const points = parseInt(val, 10); if (!points) return;
    gate("redeem points", async (pin) => {
      try {
        await api.post(`/members/${sel.member.id}/redeem`, { points, manager_pin: pin });
        toast.success("Redeemed to credit"); refresh();
      } catch (e) { toast.error(errMsg(e, "Redeem failed")); }
    });
  };

  const grant = () => {
    const kind = prompt("Reward kind: percent / cash / bxgy", "percent"); if (!kind) return;
    let body = { kind };
    if (kind === "bxgy") { body.buy_qty = parseInt(prompt("Buy qty", "2") || "0", 10); body.get_qty = parseInt(prompt("Get free qty", "1") || "0", 10); }
    else body.value = parseFloat(prompt(kind === "percent" ? "Percent off" : "Cash off HK$", "10") || "0");
    gate("grant reward", async (pin) => {
      try { await api.post(`/members/${sel.member.id}/rewards`, { ...body, manager_pin: pin }); toast.success("Reward granted"); refresh(); }
      catch (e) { toast.error(errMsg(e, "Failed")); }
    });
  };

  const saveEdit = async (patch) => {
    try { await api.patch(`/members/${sel.member.id}`, patch); toast.success("Saved"); setEditing(false); refresh(); }
    catch (e) { toast.error(errMsg(e, "Save failed")); }
  };

  const statement = async () => {
    try {
      const { data } = await api.get(`/members/${sel.member.id}/statement`);
      openPrintableWindow(statementHtml(data), "statement");
    } catch (e) { toast.error(errMsg(e, "Failed")); }
  };

  const editConfig = () => {
    const ppd = parseFloat(prompt("Points per HK$1 (0.1 = 1pt/$10)", String(cfg?.points_per_hkd ?? 0.1)) || "0.1");
    const cost = parseInt(prompt("Points per coupon block", String(cfg?.coupon_points_cost ?? 100)) || "100", 10);
    const value = parseFloat(prompt("HK$ credit per coupon block", String(cfg?.coupon_value ?? 10)) || "10");
    api.put("/loyalty/config", { ...cfg, points_per_hkd: ppd, coupon_points_cost: cost, coupon_value: value })
      .then(r => { setCfg(r.data); toast.success("Loyalty rules updated"); })
      .catch(e => toast.error(errMsg(e, "Failed")));
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <h1 className="font-display text-2xl font-black">Members · Live Tab CRM</h1>
        <div className="ml-auto flex items-center gap-2">
          {isManager && (
            <button data-testid="btn-loyalty-config" onClick={editConfig} className="px-3 py-2 rounded-lg text-xs uppercase flex items-center gap-2 bg-[var(--surface)] border border-[var(--border)] text-[var(--muted)] hover:text-white">
              <Settings size={14} /> Rules
            </button>
          )}
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
            <input data-testid="member-list-search" value={q}
              onChange={(e) => { setQ(e.target.value); load(e.target.value); }}
              placeholder="Search name/phone"
              className="bg-[var(--surface)] border border-[var(--border)] rounded-lg pl-9 pr-3 py-2 text-sm w-64" />
          </div>
          <button data-testid="btn-add-member" onClick={addMember} className="btn-neon px-4 py-2 rounded-lg text-xs uppercase flex items-center gap-2">
            <Plus size={14} /> Add
          </button>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-7 space-y-2">
          {members.map((m) => (
            <button key={m.id} data-testid={`member-row-${m.name}`} onClick={() => openMember(m)}
              className="w-full text-left p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--cyan)] flex items-center gap-3">
              <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-black" style={{ background: TIER_COLOR[m.tier] || "#94A3B8" }}>
                {m.name?.[0]}
              </div>
              <div className="flex-1">
                <div className="font-semibold">{m.name}</div>
                <div className="text-xs text-[var(--muted)]">{m.phone}</div>
              </div>
              <div className="text-right">
                <div className="text-[10px] font-mono uppercase" style={{ color: TIER_COLOR[m.tier] }}>{m.tier}</div>
                <div className="font-mono font-bold text-[var(--amber)]">{fmtHKD(m.lifetime_spend)}</div>
              </div>
              <div className="text-right text-[10px] font-mono text-[var(--muted)] w-24">
                <div className="text-[var(--cyan)]">{m.points} pts</div>
                <div className="text-[var(--emerald)]">{fmtHKD(m.credit_balance || 0)} credit</div>
              </div>
            </button>
          ))}
          {members.length === 0 && <div className="text-[var(--muted)] text-sm">No members found.</div>}
        </div>

        <div className="col-span-5">
          {sel ? (
            <div data-testid="member-detail" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sticky top-0">
              <div className="flex items-center gap-3">
                <div className="w-14 h-14 rounded-full flex items-center justify-center font-black text-black text-xl" style={{ background: TIER_COLOR[sel.member.tier] || "#94A3B8" }}>
                  {sel.member.name?.[0]}
                </div>
                <div>
                  <div className="font-display font-black text-xl">{sel.member.name}</div>
                  <div className="text-xs text-[var(--muted)]">{sel.member.phone}{sel.member.email ? ` · ${sel.member.email}` : ""}</div>
                </div>
                <button data-testid="btn-edit-member" onClick={() => setEditing(v => !v)} className="ml-auto text-[var(--muted)] hover:text-[var(--cyan)]" title="Edit profile"><Pencil size={16} /></button>
              </div>

              {editing && <EditForm member={sel.member} onSave={saveEdit} onCancel={() => setEditing(false)} />}

              {/* Live tab balances */}
              <div className="grid grid-cols-2 gap-2 mt-4">
                <Balance icon={Coins} label="Points" value={sel.member.points} color="#00F2FE" testid="mem-points" />
                <Balance icon={Wallet} label="Credit" value={fmtHKD(sel.member.credit_balance || 0)} color="#10B981" testid="mem-credit" />
                <Balance icon={Percent} label="Discount" value={`${sel.member.member_discount_pct || 0}%`} color="#A855F7" testid="mem-discount" />
                <Balance icon={Crown} label="Tier" value={sel.member.tier} color={TIER_COLOR[sel.member.tier]} testid="mem-tier" />
              </div>
              <div className="grid grid-cols-3 gap-2 mt-2">
                <Metric label="Lifetime" value={fmtHKD(sel.member.lifetime_spend)} />
                <Metric label="Visits" value={sel.member.visits} />
                <Metric label="Avg Dur." value={`${sel.member.avg_duration_min}m`} />
              </div>

              {/* Money-adjacent actions */}
              <div className="grid grid-cols-2 gap-2 mt-4">
                <ActBtn testid="act-adjust-points" onClick={() => adjust("points")} icon={Coins} label="Adjust Points" />
                <ActBtn testid="act-adjust-credit" onClick={() => adjust("credit")} icon={Wallet} label="Adjust Credit" />
                <ActBtn testid="act-redeem" onClick={redeem} icon={Gift} label="Redeem → Credit" />
                <ActBtn testid="act-discount" onClick={setDiscount} icon={Percent} label="Set Discount%" />
                <ActBtn testid="act-grant" onClick={grant} icon={Gift} label="Grant Reward" />
                <ActBtn testid="act-statement" onClick={statement} icon={Printer} label="Statement" />
              </div>

              {/* Rewards */}
              {(sel.member.rewards || []).filter(r => !r.redeemed).length > 0 && (
                <div className="mt-4">
                  <div className="text-[10px] font-mono uppercase text-[var(--muted)] mb-1">Active Rewards</div>
                  <div className="flex flex-wrap gap-1">
                    {(sel.member.rewards || []).filter(r => !r.redeemed).map((r, i) => (
                      <span key={r.code || i} className="text-[10px] px-2 py-0.5 rounded bg-[var(--purple)]/15 border border-[var(--purple)]/40 text-[var(--purple)]">{r.label}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent orders */}
              <div className="mt-4">
                <div className="text-[10px] font-mono uppercase text-[var(--muted)] mb-1 flex items-center gap-1"><TrendingUp size={12} /> Recent Orders</div>
                <div className="space-y-1 max-h-56 overflow-y-auto">
                  {sel.orders.map((o) => (
                    <div key={o.id} data-testid={`crm-order-${o.id}`} className="p-2 rounded bg-[var(--surface-2)] border border-[var(--border)] flex justify-between text-xs items-center">
                      <div>
                        <div className="font-mono text-[10px] text-[var(--muted)]">#{o.id.slice(-6)}</div>
                        <div>{o.lines?.length || 0} items · {o.order_type}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="font-mono font-bold text-[var(--amber)]">{fmtHKD(o.total)}</div>
                        <button data-testid={`crm-receipt-${o.id}`} onClick={() => setReceipt(o)} className="w-7 h-7 rounded bg-[var(--surface)] hover:bg-[var(--cyan)]/20 hover:text-[var(--cyan)] flex items-center justify-center" title="View receipt"><Printer size={12} /></button>
                      </div>
                    </div>
                  ))}
                  {sel.orders.length === 0 && <div className="text-xs text-[var(--muted)]">No orders yet</div>}
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-[var(--border)] p-10 text-center text-[var(--muted)] text-sm">Pick a member to see their live tab</div>
          )}
        </div>
      </div>

      {receipt && <Receipt order={receipt} memberName={sel?.member?.name} onClose={() => setReceipt(null)} />}
      {pinGate && (
        <ManagerPin action={pinGate.action}
          onSuccess={(mgr, pin) => { pinGate.run(pin); setPinGate(null); }}
          onClose={() => setPinGate(null)} />
      )}
    </div>
  );
}

function EditForm({ member, onSave, onCancel }) {
  const [f, setF] = useState({ name: member.name, phone: member.phone, email: member.email || "", notes: member.notes || "", tier: member.tier });
  return (
    <div className="mt-3 p-3 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] space-y-2">
      {[["name", "Name"], ["phone", "Phone"], ["email", "Email"], ["notes", "Notes"]].map(([k, l]) => (
        <input key={k} data-testid={`edit-${k}`} value={f[k]} placeholder={l} onChange={(e) => setF({ ...f, [k]: e.target.value })}
          className="w-full bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1.5 text-sm" />
      ))}
      <select data-testid="edit-tier" value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })}
        className="w-full bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1.5 text-sm">
        {["Regular", "Silver", "Gold", "VIP"].map(t => <option key={t} value={t}>{t}</option>)}
      </select>
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 py-1.5 rounded bg-[var(--surface)] text-xs">Cancel</button>
        <button data-testid="edit-save" onClick={() => onSave(f)} className="flex-1 btn-neon py-1.5 rounded text-xs">Save</button>
      </div>
      <div className="text-[10px] font-mono text-[var(--muted)]">Staff may edit profile only · money changes are manager-gated</div>
    </div>
  );
}

const Balance = ({ icon: Icon, label, value, color, testid }) => (
  <div data-testid={testid} className="p-3 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
    <div className="text-[9px] font-mono uppercase text-[var(--muted)] flex items-center gap-1"><Icon size={11} style={{ color }} /> {label}</div>
    <div className="font-display font-black text-lg mt-0.5" style={{ color }}>{value}</div>
  </div>
);
const Metric = ({ label, value }) => (
  <div className="p-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
    <div className="text-[9px] font-mono uppercase text-[var(--muted)]">{label}</div>
    <div className="font-display font-bold text-white">{value}</div>
  </div>
);
const ActBtn = ({ icon: Icon, label, onClick, testid }) => (
  <button data-testid={testid} onClick={onClick} className="py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] text-xs font-mono uppercase text-white hover:border-[var(--cyan)] flex items-center justify-center gap-1.5">
    <Icon size={13} className="text-[var(--cyan)]" /> {label}
  </button>
);

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function ts(iso) { return iso ? new Date(iso).toLocaleString("en-HK", { timeZone: "Asia/Hong_Kong", hour12: false }) : "—"; }

function statementHtml(d) {
  const m = d.member;
  const earn = (d.earning_history || []).map(e => `<tr><td>${ts(e.date)}</td><td class="r">HK$ ${(e.total || 0).toFixed(2)}</td><td class="r">+${e.points_earned}</td></tr>`).join("")
    || `<tr><td colspan="3" class="s">No point-earning visits yet</td></tr>`;
  const rewards = (d.rewards || []).map(r => `<tr><td>${esc(r.label)}</td><td>${esc(r.type)}</td><td class="r">${r.redeemed ? "used" : "active"}</td></tr>`).join("")
    || `<tr><td colspan="3" class="s">No rewards issued</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Member Statement</title>
<style>body{font-family:'JetBrains Mono',monospace;font-size:12px;width:320px;margin:0;padding:14px;color:#000}
h1{font-size:20px;text-align:center;margin:0;letter-spacing:.15em}
h2{font-size:10px;text-align:center;margin:0 0 10px;letter-spacing:.25em;color:#666}
h3{font-size:11px;text-transform:uppercase;letter-spacing:.1em;margin:12px 0 4px;color:#333}
hr{border:0;border-top:1px dashed #000;margin:8px 0}
table{width:100%;border-collapse:collapse}td{padding:2px 0;vertical-align:top}
.r{text-align:right}.s{color:#666;font-size:10px}
.kpi{display:flex;justify-content:space-between;font-weight:900;font-size:15px;margin:2px 0}
@page{size:auto;margin:5mm}</style></head><body>
<h1>HK · BAR</h1><h2>MEMBER STATEMENT</h2>
<div class="s">${esc(m.name)} · ${esc(m.phone || "")}</div>
<div class="s">Tier: ${esc(m.tier)} (x${d.tier_multiplier}) · Since ${ts(m.join_date)}</div>
<div class="s">Last visit: ${ts(m.last_visit)}</div>
<hr/>
<div class="kpi"><span>POINTS</span><span>${d.points}</span></div>
<div class="kpi"><span>CREDIT</span><span>HK$ ${d.credit_balance.toFixed(2)}</span></div>
<div class="s">Lifetime spend HK$ ${d.lifetime_spend.toFixed(2)} · ${d.visits} visits · earn rate ${d.points_per_hkd} pt/HK$</div>
<h3>Earning history</h3>
<table><tr><td class="s">Date</td><td class="r s">Spend</td><td class="r s">Points</td></tr>${earn}</table>
<h3>Rewards</h3>
<table><tr><td class="s">Reward</td><td class="s">Type</td><td class="r s">Status</td></tr>${rewards}</table>
<hr/><div class="s" style="text-align:center">Generated ${ts(d.generated_at)}</div>
</body></html>`;
}

