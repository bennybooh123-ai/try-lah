import { useState } from "react";
import { X, CreditCard, User as UserIcon, Users } from "lucide-react";

function usePreauthForm(table, onOpened) {
  const [name, setName] = useState("");
  const [last4, setLast4] = useState("");
  const [hold, setHold] = useState(500);
  const [size, setSize] = useState(table?.seats || 2);
  const [busy, setBusy] = useState(false);
  const [stripeReady, setStripeReady] = useState(false);
  const [stripeInfo, setStripeInfo] = useState(null);

  const canOpen = name.trim() && /^\d{4}$/.test(last4);

  const createStripeHold = async () => {
    setBusy(true);
    try {
      const r = await (await import("@/lib/api")).api.post("/tabs/preauth/setup-intent", {
        customer_name: name.trim() || "Guest",
        metadata: { hold_amount: String(hold) },
      });
      setStripeInfo(r.data);
      setStripeReady(true);
    } catch (e) { console.error(e); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    setBusy(true);
    try {
      await onOpened({
        customer_name: name.trim(),
        card_last4: last4,
        hold_amount: parseFloat(hold) || 0,
        table_id: table?.id || null,
        party_size: parseInt(size, 10) || 1,
      });
    } finally { setBusy(false); }
  };

  return { name, setName, last4, setLast4, hold, setHold, size, setSize,
           busy, stripeReady, stripeInfo, canOpen, createStripeHold, submit };
}

export default function PreauthModal({ table, onClose, onOpened }) {
  const f = usePreauthForm(table, onOpened);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="font-display font-black text-xl flex items-center gap-2">
              <CreditCard className="text-[var(--cyan)]" size={20} /> Preauth Tab
            </div>
            <div className="text-[10px] font-mono uppercase text-[var(--muted)]">
              {table ? `Table ${table.name}` : "Standing / bar tab"} · card-on-file style
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--muted)]"><X size={20} /></button>
        </div>
        <div className="space-y-3">
          <Field icon={UserIcon} label="Guest name">
            <input data-testid="preauth-name" value={f.name} onChange={(e) => f.setName(e.target.value)}
              className={inp} placeholder="e.g. Michael Cheung" />
          </Field>
          <Field icon={CreditCard} label="Card last 4">
            <input data-testid="preauth-last4" value={f.last4} inputMode="numeric" maxLength="4"
              onChange={(e) => f.setLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
              className={`${inp} font-mono tracking-widest`} placeholder="1234" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Hold amount HKD">
              <input data-testid="preauth-hold" type="number" min="0" value={f.hold}
                onChange={(e) => f.setHold(e.target.value)} className={inp} />
            </Field>
            <Field icon={Users} label="Party size">
              <input data-testid="preauth-size" type="number" min="1" value={f.size}
                onChange={(e) => f.setSize(e.target.value)} className={inp} />
            </Field>
          </div>
          <StripeHoldStatus ready={f.stripeReady} info={f.stripeInfo} />
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2.5 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">Cancel</button>
          <button data-testid="preauth-stripe" onClick={f.createStripeHold} disabled={f.busy || !f.name.trim() || f.stripeReady}
            className="flex-1 py-2.5 rounded-lg bg-[var(--surface-2)] border border-[var(--cyan)] text-[var(--cyan)] disabled:opacity-40">
            {f.stripeReady ? "Hold Created ✓" : (f.busy ? "Creating…" : "Create Card Hold")}
          </button>
          <button data-testid="preauth-open" onClick={f.submit} disabled={!f.canOpen || f.busy}
            className="flex-1 btn-neon py-2.5 rounded-lg disabled:opacity-40">
            {f.busy ? "Opening…" : "Open Tab"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StripeHoldStatus({ ready, info }) {
  return (
    <div className="p-2.5 rounded-lg bg-[var(--cyan)]/10 border border-[var(--cyan)]/30 text-[10px] font-mono text-[var(--cyan)] leading-relaxed">
      {ready ? (
        <>Stripe SetupIntent <span className="font-black">{info?.setup_intent_id?.slice(0, 12)}…</span> created ✓ · At last call, auto-close charges the on-file card.</>
      ) : (
        <>Click <span className="font-black">Create Card Hold</span> to reserve a real Stripe SetupIntent (test-mode) — or open the tab with the last-4 only.</>
      )}
    </div>
  );
}

const inp = "w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-white focus:border-[var(--cyan)] focus:outline-none";
const Field = ({ icon: Icon, label, children }) => (
  <div>
    <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)] mb-1 flex items-center gap-1">
      {Icon && <Icon size={10} />} {label}
    </div>
    {children}
  </div>
);
