import { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { api, fmtHKD } from "@/lib/api";
import { Sparkles, Search, MapPin } from "lucide-react";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;

export default function MobileMenu() {
  const { tableId } = useParams();
  const [data, setData] = useState(null);
  const [q, setQ] = useState("");
  const [activeCat, setActiveCat] = useState(null);
  const [cart, setCart] = useState({});
  const [placed, setPlaced] = useState(null);
  const [placing, setPlacing] = useState(false);
  const [bill, setBill] = useState(null);
  const [paidReq, setPaidReq] = useState(false);

  const loadBill = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND_URL}/api/public/bill/${tableId}`);
      if (r.ok) setBill(await r.json());
    } catch (err) {
      console.warn("[bill] fetch failed (offline?)", err);
    }
  }, [tableId, BACKEND_URL]);
  useEffect(() => { loadBill(); const t = setInterval(loadBill, 10000); return () => clearInterval(t); }, [loadBill]);

  const requestFpsPay = async () => {
    try {
      const r = await fetch(`${BACKEND_URL}/api/public/pay-request`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: bill.order_id, method: "fps" }),
      });
      if (!r.ok) throw new Error((await r.json()).detail || "Failed");
      setPaidReq(true);
      loadBill();
    } catch (e) { alert(e.message); }
  };

  const add = (p) => setCart((c) => ({ ...c, [p.id]: { p, qty: (c[p.id]?.qty || 0) + 1 } }));
  const dec = (p) => setCart((c) => {
    const qty = (c[p.id]?.qty || 0) - 1;
    const n = { ...c };
    if (qty <= 0) delete n[p.id]; else n[p.id] = { p, qty };
    return n;
  });
  const cartItems = Object.values(cart);
  const cartTotal = cartItems.reduce((a, { p, qty }) => a + p.price * qty, 0);

  const placeOrder = async () => {
    setPlacing(true);
    try {
      const r = await fetch(`${BACKEND_URL}/api/public/order/${tableId}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: cartItems.map(({ p, qty }) => ({ product_id: p.id, qty })) }),
      });
      if (!r.ok) throw new Error((await r.json()).detail || "Order failed");
      setPlaced(await r.json());
      setCart({});
    } catch (e) {
      alert(e.message);
    } finally { setPlacing(false); }
  };

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/api/public/menu/${tableId}`);
        if (!r.ok) throw new Error("Not found");
        const d = await r.json();
        setData(d);
        setActiveCat(d.categories[0]?.id || null);
      } catch (e) {
        setData({ error: "Table not found" });
      }
    })();
  }, [tableId]);

  if (!data) return <FullScreenSpinner />;
  if (data.error) return <div className="min-h-screen flex items-center justify-center text-[var(--muted)]">{data.error}</div>;

  if (placed) return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center p-6" data-testid="order-placed-screen">
      <div className="text-center max-w-sm">
        <div className="w-16 h-16 mx-auto rounded-full bg-[var(--emerald)]/15 text-[var(--emerald)] flex items-center justify-center font-display font-black text-2xl mb-4">✓</div>
        <div className="font-display font-black text-2xl mb-2">Order sent to the bar</div>
        <div className="text-sm text-[var(--muted)] mb-1">Order #{placed.order_id.slice(0, 6)} · {fmtHKD(placed.total)}</div>
        <div className="text-xs text-[var(--muted)] mb-6">Our team will confirm and fire it to the kitchen/bar. Pay at the table when you're ready.</div>
        <button data-testid="order-more-btn" onClick={() => setPlaced(null)}
          className="px-6 py-3 rounded-lg bg-[var(--cyan)] text-black font-bold">Order more</button>
      </div>
    </div>
  );

  const activeHhIds = new Set();
  (data.active_hh || []).forEach(h => (h.category_ids || []).forEach(id => activeHhIds.add(id)));
  const hhPercent = (data.active_hh?.[0]?.percent_off) || 0;

  const filtered = (data.products || []).filter(p => {
    const inCat = !activeCat || p.category_id === activeCat;
    const inQ = !q || p.name.toLowerCase().includes(q.toLowerCase());
    return inCat && inQ;
  });

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] noise pb-20" data-testid="mobile-menu">
      <div className="max-w-md mx-auto px-4">
        {/* Header */}
        <div className="pt-6 pb-4 sticky top-0 bg-[var(--bg)]/80 backdrop-blur-md z-20 -mx-4 px-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-display font-black text-3xl">
                <span className="text-[var(--cyan)]">HK</span>
                <span className="text-white">·</span>
                <span className="text-[var(--amber)]">BAR</span>
              </div>
              <div className="text-[10px] font-mono uppercase tracking-[0.3em] text-[var(--muted)] mt-1">
                Advanced POS · Hong Kong
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] font-mono uppercase text-[var(--muted)] flex items-center gap-1 justify-end">
                <MapPin size={10} /> Your Table
              </div>
              <div className="font-display font-black text-2xl text-[var(--cyan)]">
                {data.table?.name}
              </div>
              {data.area && <div className="text-[10px] font-mono text-[var(--muted)]">{data.area.name}</div>}
            </div>
          </div>

          {data.active_hh?.length > 0 && (
            <div className="mt-3 px-3 py-2 rounded-lg border border-[var(--amber)]/50 bg-[var(--amber)]/10 flex items-center gap-2 text-xs">
              <Sparkles size={14} className="text-[var(--amber)]" />
              <span className="font-mono uppercase font-bold text-[var(--amber)] tracking-widest">Happy Hour</span>
              <span className="text-[var(--muted)]">-{hhPercent}% until {data.active_hh[0].end_time}</span>
            </div>
          )}

          <div className="mt-3 relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
            <input
              data-testid="menu-search"
              placeholder="Search menu…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="w-full bg-[var(--surface)] border border-[var(--border)] rounded-lg pl-9 pr-3 py-2.5 text-sm text-white focus:border-[var(--cyan)] focus:outline-none"
            />
          </div>

          <div className="flex gap-1.5 mt-3 overflow-x-auto pb-1 -mx-1 px-1">
            {data.categories.map(c => (
              <button
                key={c.id}
                data-testid={`m-cat-${c.name}`}
                onClick={() => setActiveCat(c.id)}
                className={`px-3 py-1.5 rounded-full text-xs font-mono uppercase whitespace-nowrap border transition ${
                  activeCat === c.id
                    ? "text-black border-transparent"
                    : "bg-[var(--surface)] text-[var(--muted)] border-[var(--border)]"
                }`}
                style={activeCat === c.id ? { background: c.color } : {}}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>

        {/* Product list */}
        <div className="space-y-2 mt-3">
          {filtered.map(p => {
            const hh = activeHhIds.has(p.category_id) && p.happy_hour_eligible && hhPercent > 0;
            const price = hh ? p.price * (1 - hhPercent / 100) : p.price;
            return (
              <div key={p.id} data-testid={`m-prod-${p.name}`} className="p-3 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                <div className="flex justify-between gap-3">
                  <div className="flex-1">
                    <div className="font-display font-bold">{p.name}</div>
                    <div className="text-[10px] font-mono uppercase text-[var(--muted)]">{p.course}</div>
                    {p.description && <div className="text-xs text-[var(--muted)] mt-1">{p.description}</div>}
                    {p.variants?.length > 0 && (
                      <div className="mt-1 text-[10px] font-mono text-[var(--muted)]">
                        {p.variants.map(v => v.name).join(" · ")}
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0 flex flex-col items-end gap-1.5">
                    {hh ? (
                      <>
                        <div className="font-mono font-black text-[var(--amber)]">{fmtHKD(price)}</div>
                        <div className="text-[10px] font-mono line-through text-[var(--muted)]">{fmtHKD(p.price)}</div>
                        <div className="text-[9px] font-mono uppercase text-[var(--amber)] font-bold">-{hhPercent}%</div>
                      </>
                    ) : (
                      <div className="font-mono font-black text-[var(--amber)]">{fmtHKD(p.price)}</div>
                    )}
                    <div className="flex items-center gap-1.5">
                      {cart[p.id] && (
                        <>
                          <button data-testid={`m-dec-${p.name}`} onClick={() => dec(p)}
                            className="w-7 h-7 rounded-md bg-[var(--surface-2)] border border-[var(--border)] font-mono font-bold">−</button>
                          <span className="font-mono font-bold text-sm w-5 text-center" data-testid={`m-qty-${p.name}`}>{cart[p.id].qty}</span>
                        </>
                      )}
                      <button data-testid={`m-add-${p.name}`} onClick={() => add(p)}
                        className="w-7 h-7 rounded-md bg-[var(--cyan)] text-black font-mono font-black">+</button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="text-center text-[var(--muted)] text-sm py-8">No items match your search.</div>
          )}
        </div>

        <div className="mt-8 pt-6 border-t border-[var(--border)] text-center text-[10px] font-mono text-[var(--muted)] pb-24">
          Orders go straight to our team for confirmation.
          <br />10% service charge applies to all orders.
        </div>
      </div>

      {/* Live bill + FPS pay-at-seat */}
      {bill && bill.status === "open" && (
        <div className="mt-6 rounded-xl border border-[var(--cyan)]/40 bg-[var(--surface)] p-4" data-testid="guest-bill-panel">
          <div className="font-mono text-xs uppercase tracking-widest text-[var(--cyan)] font-bold mb-3">Your bill so far</div>
          <div className="space-y-1 mb-3">
            {bill.lines.map((l) => (
              <div key={`${l.name}-${l.qty}-${l.price}`} className="flex justify-between text-sm">
                <span>{l.qty}× {l.name}</span>
                <span className="font-mono">{fmtHKD(l.price * l.qty)}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-[var(--border)] pt-2 space-y-1 font-mono text-sm">
            <div className="flex justify-between text-[var(--muted)]"><span>Subtotal</span><span>{fmtHKD(bill.subtotal)}</span></div>
            <div className="flex justify-between text-[var(--muted)]"><span>Service 10%</span><span>{fmtHKD(bill.service_charge)}</span></div>
            <div className="flex justify-between font-black text-lg text-[var(--amber)]"><span>Total</span><span data-testid="guest-bill-total">{fmtHKD(bill.total)}</span></div>
          </div>
          {bill.payment_pending || paidReq ? (
            <div className="mt-3 py-3 rounded-lg bg-[var(--emerald)]/10 border border-[var(--emerald)]/40 text-center text-sm font-semibold text-[var(--emerald)]" data-testid="fps-pending-note">
              FPS payment sent — staff will confirm shortly
            </div>
          ) : (
            <button data-testid="fps-pay-btn" onClick={requestFpsPay}
              className="mt-3 w-full py-3.5 rounded-lg bg-[#00A8FF] text-black font-display font-black">
              Pay {fmtHKD(bill.total)} with FPS 轉數快
            </button>
          )}
        </div>
      )}

      {/* Cart bar */}
      {cartItems.length > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-30 p-4" data-testid="qr-cart-bar">
          <div className="max-w-md mx-auto rounded-xl bg-[var(--surface-2)] border border-[var(--cyan)]/50 shadow-2xl p-3 flex items-center gap-3">
            <div className="flex-1">
              <div className="font-mono font-bold text-sm" data-testid="qr-cart-count">{cartItems.reduce((a, i) => a + i.qty, 0)} item(s)</div>
              <div className="font-mono text-xs text-[var(--muted)]">{fmtHKD(cartTotal)} + 10% svc</div>
            </div>
            <button data-testid="qr-place-order" onClick={placeOrder} disabled={placing}
              className="px-5 py-3 rounded-lg bg-[var(--cyan)] text-black font-display font-black disabled:opacity-40">
              {placing ? "Sending…" : "Place Order"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FullScreenSpinner() {
  return (
    <div className="min-h-screen flex items-center justify-center text-[var(--muted)] font-mono text-xs uppercase tracking-widest">
      Loading menu…
    </div>
  );
}
