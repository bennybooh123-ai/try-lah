import { useEffect, useMemo, useState, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { useAuth } from "@/context/AuthContext";
import ProductGrid from "@/components/pos/register/ProductGrid";
import CartTicket from "@/components/pos/register/CartTicket";
import RegisterUpsellStrip from "@/components/pos/register/RegisterUpsellStrip";
import VariantModal from "@/components/pos/register/VariantModal";
import PaymentModal from "@/components/pos/register/PaymentModal";
import Receipt from "@/components/pos/Receipt";
import ManagerPin from "@/components/pos/ManagerPin";
import { errMsg } from "@/lib/errors";
import { useHappyHour } from "@/components/pos/register/useHappyHour";

export default function Register() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { user } = useAuth();

  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [combos, setCombos] = useState([]);
  const [activeCat, setActiveCat] = useState(null);
  const [order, setOrder] = useState(null);
  const [variantModal, setVariantModal] = useState(null);
  const [payModal, setPayModal] = useState(false);
  const [receiptOrder, setReceiptOrder] = useState(null);
  const [members, setMembers] = useState([]);
  const [memberQ, setMemberQ] = useState("");
  const [pinGate, setPinGate] = useState(null);

  const orderId = sp.get("order");
  const tableId = sp.get("table");
  const areaId = sp.get("area");

  // ---- Happy Hour helpers (shared hook) ----
  const { activeHH, hhFor, hhPrice } = useHappyHour();

  // ---- Data loading ----
  useEffect(() => {
    api.get("/categories").then((r) => {
      setCategories(r.data);
      setActiveCat((cur) => cur || r.data[0]?.id || null);
    });
    api.get("/products").then((r) => setProducts(r.data));
    api.get("/combos").then((r) => setCombos(r.data));
  }, [api]);

  useEffect(() => {
    if (orderId) {
      api.get(`/orders/${orderId}`).then(async (r) => {
        const ord = r.data;
        if (ord.member_id) {
          try {
            const { data } = await api.get(`/members/${ord.member_id}/tab`);
            ord.member_name = data.name;
            ord.member_credit = data.credit_balance || 0;
            ord.member_points = data.points || 0;
            ord.member_discount_pct = data.member_discount_pct || 0;
          } catch { /* non-blocking */ }
        }
        setOrder(ord);
      });
    } else {
      setOrder({
        order_type: tableId ? "dine_in" : "pick_up",
        table_id: tableId, area_id: areaId,
        guests: 2, lines: [],
        discount_type: "none", discount_value: 0,
        service_charge_pct: 10, notes: "",
        subtotal: 0, discount: 0, service_charge: 0, total: 0,
        status: "draft",
      });
    }
  }, [orderId, tableId, areaId, api]);

  // ---- Totals (frontend mirrors backend exclusivity rule) ----
  const totals = useMemo(() => {
    if (!order) return {
      subtotal: 0, discount: 0, service: 0, total: 0,
      combos_applied: [], hh_locked: new Set(), combo_locked: new Set(),
      combo_line_map: {},
    };
    const sub = order.lines.reduce((s, l) => s + l.price * l.qty, 0);

    // 1) HH lock — any line the register already priced at happy-hour value
    const hhLocked = new Set(
      order.lines.filter(l => (l.hh_pct || 0) > 0 && l.product_id).map(l => l.product_id)
    );

    // 2) Build combo-eligible qty map (skip HH-locked pids)
    const lineQtys = {};
    order.lines.forEach(l => {
      if (l.product_id && !hhLocked.has(l.product_id) && (l.qty || 0) > 0) {
        lineQtys[l.product_id] = (lineQtys[l.product_id] || 0) + l.qty;
      }
    });

    // 3) Greedy best-first combo application
    const applied = [];
    const comboLocked = new Set();
    const comboLineMap = {}; // pid -> combo name (for UI badge)
    const potential = (c) =>
      c.discount_type === "percent" ? sub * (c.discount_value / 100) : c.discount_value;
    const sortedCombos = [...combos]
      .filter(c => c.active !== false)
      .sort((a, b) => potential(b) - potential(a));

    let comboDisc = 0;
    for (const c of sortedCombos) {
      const involved = new Set();
      (c.slots || []).forEach(s => (s.product_ids || []).forEach(pid => involved.add(pid)));
      if (!c.slots || !c.slots.length) (c.product_ids || []).forEach(pid => involved.add(pid));

      // Skip if any product already locked by another combo
      let overlap = false;
      involved.forEach(pid => { if (comboLocked.has(pid)) overlap = true; });
      if (overlap) continue;

      // Match check (mirrors backend _combo_matches, on lineQtys map that excludes HH-locked)
      let matches;
      if (c.slots && c.slots.length) {
        matches = c.slots.every(s => {
          const pids = s.product_ids || [];
          if (!pids.length) return false;
          const counts = pids.map(pid => lineQtys[pid] || 0);
          const total = counts.reduce((a, b) => a + b, 0);
          const min = s.min_qty ?? 1, max = s.max_qty ?? 99;
          if (s.operator === "and") return counts.every(n => n >= 1) && counts.every(n => n <= max);
          return total >= min && total <= max;
        });
      } else {
        const req = [...involved];
        matches = req.length > 0 && req.every(pid => (lineQtys[pid] || 0) >= 1);
      }
      if (!matches) continue;

      const d = potential(c);
      comboDisc += d;
      applied.push({ name: c.name, discount: d, locked_product_ids: [...involved] });
      involved.forEach(pid => {
        comboLocked.add(pid);
        comboLineMap[pid] = c.name;
        delete lineQtys[pid];
      });
    }

    // 4) Order-level discount only against lines NOT locked by HH or a combo
    const promoLocked = new Set([...hhLocked, ...comboLocked]);
    const discBase = order.lines
      .filter(l => !promoLocked.has(l.product_id))
      .reduce((s, l) => s + l.price * l.qty, 0);
    let disc = 0;
    if (order.discount_type === "percent") disc = discBase * (order.discount_value / 100);
    else if (order.discount_type === "cash") disc = Math.min(order.discount_value, discBase);

    const net = Math.max(0, sub - disc - comboDisc);
    const svc = net * (order.service_charge_pct / 100);
    return {
      subtotal: sub, discount: disc, service: svc, total: net + svc,
      combos_applied: applied,
      hh_locked: hhLocked, combo_locked: comboLocked, combo_line_map: comboLineMap,
    };
  }, [order, combos]);

  // ---- Actions ----
  const pushLine = (p, variant, mods, unitPrice) => {
    setOrder((o) => {
      const key = `${p.id}|${variant || ""}|${mods.join(",")}`;
      const idx = o.lines.findIndex((l) => `${l.product_id}|${l.variant || ""}|${l.modifiers.join(",")}` === key && !l.held);
      let lines;
      const hhPct = hhFor(p);
      if (idx >= 0) {
        lines = [...o.lines];
        lines[idx] = { ...lines[idx], qty: lines[idx].qty + 1 };
      } else {
        lines = [...o.lines, {
          product_id: p.id, name: p.name + (variant ? ` (${variant})` : ""),
          price: unitPrice, qty: 1, variant, modifiers: mods,
          course: p.course, held: false, notes: "",
          hh_pct: hhPct,   // <— locks this product from combos + other discounts
        }];
      }
      return { ...o, lines };
    });
  };

  const addProduct = async (p) => {
    // Substitution Pop — check if the tapped product is out (86'd or all-kegs-blown)
    if (p.eightysix) {
      try {
        const r = await api.get(`/products/${p.id}/substitutes`);
        const subs = r.data.substitutes || [];
        if (subs.length) {
          toast(`${p.name} is out. Try ${subs[0].name} · HK$${subs[0].price} instead`, {
            action: { label: "Add substitute", onClick: () => addProduct(subs[0]) },
          });
        } else {
          toast.error(`${p.name} is out and no substitute available`);
        }
      } catch {
        toast.error(`${p.name} is 86'd`);
      }
      return;
    }
    if (p.variants?.length > 0) return setVariantModal(p);
    pushLine(p, null, [], hhPrice(p));
  };

  const removeLine = (i) => {
    const line = order.lines[i];
    // Saved order -> audited void with reason code (+ wastage if already fired)
    if (order?.id) {
      const doVoid = async (mgrPin) => {
        const reason = prompt("Void reason: wrong order / spillage / on the house / returned / other", "wrong order") || "other";
        try {
          await api.post(`/orders/${order.id}/void-line`, { line_index: i, reason, manager_pin: mgrPin });
          toast.success(`Voided: ${line?.name} (${reason})${line?.held ? "" : " — wastage logged"}`);
          const upd = await api.get(`/orders/${order.id}`);
          setOrder(upd.data);
        } catch (e) { toast.error(errMsg(e, "Void failed")); }
      };
      const isManager = ["owner", "admin", "manager", "assistant_manager"].includes(user?.role);
      if (isManager) { doVoid(undefined); return; }
      setPinGate({ action: `void "${line?.name}"`, onOk: (mgr, pin) => doVoid(pin) });
      return;
    }
    // Unsaved draft -> plain local remove
    setOrder((o) => ({ ...o, lines: o.lines.filter((_, idx) => idx !== i) }));
  };

  const repeatRound = () => {
    if (!order?.lines?.length) return toast.error("Nothing to repeat");
    const dupes = order.lines.map(l => ({ ...l, held: false }));
    setOrder(o => ({ ...o, lines: [...o.lines, ...dupes] }));
    toast.success(`Repeated ${dupes.length} item(s)`);
  };

  const saveOrder = async () => {
    if (!order.lines.length) return toast.error("No items");
    try {
      const res = order.id
        ? await api.patch(`/orders/${order.id}`, {
            lines: order.lines, discount_type: order.discount_type,
            discount_value: order.discount_value, member_id: order.member_id, notes: order.notes,
          })
        : await api.post("/orders", {
            order_type: order.order_type, table_id: order.table_id, area_id: order.area_id,
            member_id: order.member_id, guests: order.guests, lines: order.lines,
            discount_type: order.discount_type, discount_value: order.discount_value,
            service_charge_pct: 10, notes: order.notes,
          });
      setOrder((o) => ({
        ...res.data,
        member_name: o.member_name,
        member_credit: o.member_credit,
        member_points: o.member_points,
        member_discount_pct: o.member_discount_pct,
      }));
      toast.success("Order saved");
    } catch (e) {
      toast.error(errMsg(e, "Save failed"));
    }
  };

  const fireCourse = async (course) => {
    if (!order?.id) return toast.error("Save order first");
    const r = await api.post(`/orders/${order.id}/fire`, null, { params: { course } });
    toast.success(`Fired ${r.data.fired} ${course} item(s)`);
    const upd = await api.get(`/orders/${order.id}`);
    setOrder(upd.data);
  };

  const searchMember = async (q) => {
    setMemberQ(q);
    if (q.length < 2) return setMembers([]);
    const r = await api.get("/members", { params: { q } });
    setMembers(r.data.slice(0, 8));
  };

  const attachMember = async (m) => {
    setOrder((o) => ({ ...o, member_id: m.id, member_name: m.name }));
    setMembers([]); setMemberQ("");
    try {
      const { data } = await api.get(`/members/${m.id}/tab`);
      setOrder((o) => ({ ...o, member_credit: data.credit_balance || 0, member_points: data.points || 0, member_discount_pct: data.member_discount_pct || 0 }));
    } catch { /* non-blocking */ }
    toast.success(`Member: ${m.name}`);
  };

  // Selective line actions (multi-select). Void/comp are manager-gated.
  const isManager = ["owner", "admin", "manager", "assistant_manager"].includes(user?.role);
  const doLineAction = async (action, indexes, opts = {}, pin, onDone) => {
    try {
      const r = await api.post(`/orders/${order.id}/line-action`, {
        action, line_indexes: indexes, reason: opts.reason || "",
        pct: opts.pct || 0, target_seat: opts.target_seat ?? null, manager_pin: pin,
      });
      setOrder((o) => ({
        ...r.data.order,
        member_name: o.member_name,
        member_credit: o.member_credit,
        member_points: o.member_points,
        member_discount_pct: o.member_discount_pct,
      }));
      if (r.data.new_order_id) toast.success(`Split to new tab #${r.data.new_order_id.slice(-6)}`);
      else toast.success(`${action} applied`);
      onDone?.();
    } catch (e) {
      if (e?.response?.status === 403 && !pin) {
        setPinGate({ action, onOk: (mgr, p) => doLineAction(action, indexes, opts, p, onDone) });
      } else toast.error(errMsg(e, "Action failed"));
    }
  };
  const onLineAction = (action, indexes, opts, onDone) => {
    if (!order?.id) return toast.error("Save order first");
    if (!indexes.length) return;
    if (["void", "comp"].includes(action) && !isManager) {
      setPinGate({ action, onOk: (mgr, pin) => doLineAction(action, indexes, opts, pin, onDone) });
    } else {
      doLineAction(action, indexes, opts, undefined, onDone);
    }
  };

  const openPay = async () => {
    if (!order.id) await saveOrder();
    setPayModal(true);
  };

  if (!order) return <div className="text-[var(--muted)]">Loading…</div>;

  return (
    <div className="h-full grid grid-cols-12 gap-4">
      {activeHH.length > 0 && (
        <div data-testid="hh-banner" className="col-span-12 -mb-2 px-3 py-2 rounded-lg border border-[var(--amber)]/50 bg-[var(--amber)]/10 flex items-center gap-3 text-xs flex-wrap">
          <span className="pulse-dot" style={{ background: "#FFB800", boxShadow: "0 0 12px #FFB800" }} />
          <span className="font-mono uppercase tracking-widest text-[var(--amber)] font-bold">Happy Hour Live</span>
          {activeHH.map(h => (
            <span key={h.id} className="px-2 py-0.5 rounded bg-[var(--amber)]/20 border border-[var(--amber)]/40 font-mono">
              {h.name} · -{h.percent_off}% · ends {h.end_time}
            </span>
          ))}
          <span className="ml-auto text-[var(--muted)]">Best-of applied per product</span>
        </div>
      )}

      <RegisterUpsellStrip
        order={order} totals={totals} combos={combos} products={products}
        onAdd={addProduct}
      />

      <ProductGrid
        products={products} categories={categories}
        activeCat={activeCat} setActiveCat={setActiveCat}
        onPick={addProduct} hhFor={hhFor} hhPrice={hhPrice}
        user={user}
      />

      <CartTicket
        order={order} setOrder={setOrder} totals={totals} activeHH={activeHH}
        combos={combos}
        onSave={saveOrder} onPay={openPay} onRepeat={repeatRound}
        onRemoveLine={removeLine} onFireCourse={fireCourse} onLineAction={onLineAction}
        onSearchMember={searchMember} members={members} memberQ={memberQ} onAttachMember={attachMember}
      />

      {variantModal && (
        <VariantModal
          product={variantModal}
          hhPercent={hhFor(variantModal)}
          onClose={() => setVariantModal(null)}
          onPick={(variant, mods, price) => {
            pushLine(variantModal, variant, mods, price);
            setVariantModal(null);
          }}
        />
      )}

      {payModal && (
        <PaymentModal
          total={totals.total}
          guests={order.guests}
          memberCredit={order.member_credit || 0}
          memberName={order.member_name}
          onClose={() => setPayModal(false)}
          onPay={async (payload) => {
            try {
              const res = await api.post(`/orders/${order.id}/pay`, payload);
              toast.success("Payment complete");
              setPayModal(false);
              setReceiptOrder(res.data);
            } catch (e) {
              toast.error(errMsg(e, "Payment failed"));
            }
          }}
        />
      )}

      {receiptOrder && (
        <Receipt order={receiptOrder} memberName={order?.member_name}
          onClose={() => { setReceiptOrder(null); nav("/floorplan"); }} />
      )}

      {pinGate && (
        <ManagerPin action={pinGate.action}
          onSuccess={(mgr, pin) => { pinGate.onOk(mgr, pin); setPinGate(null); }}
          onClose={() => setPinGate(null)} />
      )}
    </div>
  );
}
