import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Tv, Plus, Trash2, Pencil, Radio, CalendarClock, AlertTriangle, Rss, X } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { errMsg } from "@/lib/errors";

const MANAGER = ["owner", "admin", "manager", "assistant_manager"];
const hktToUtc = (local) => (local ? new Date(local + ":00+08:00").toISOString() : "");
const fmtHKT = (iso) => (iso ? new Date(iso).toLocaleString("en-HK", { timeZone: "Asia/Hong_Kong", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" }) : "—");

export default function Events() {
  const { user } = useAuth();
  const isManager = MANAGER.includes(user?.role);
  const [board, setBoard] = useState([]);
  const [screens, setScreens] = useState([]);
  const [broadcasts, setBroadcasts] = useState([]);
  const [form, setForm] = useState(null); // schedule form
  const [tab, setTab] = useState("board");

  const load = useCallback(async () => {
    const [b, s, bc] = await Promise.all([api.get("/broadcasts/board"), api.get("/screens"), api.get("/broadcasts")]);
    setBoard(b.data); setScreens(s.data); setBroadcasts(bc.data);
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);

  const addScreen = async () => {
    const name = prompt("Screen name (e.g. TV 5 · Snug)?"); if (!name) return;
    const location = prompt("Location?", "") || "";
    try { await api.post("/screens", { name, location }); toast.success("Screen added"); load(); }
    catch (e) { toast.error(errMsg(e, "Manager only")); }
  };
  const delScreen = async (s) => {
    if (!confirm(`Delete ${s.name} and its bookings?`)) return;
    try { await api.delete(`/screens/${s.id}`); load(); } catch (e) { toast.error(errMsg(e, "Failed")); }
  };
  const delBroadcast = async (b) => {
    if (!confirm(`Remove "${b.event_title}"?`)) return;
    try { await api.delete(`/broadcasts/${b.id}`); load(); } catch (e) { toast.error(errMsg(e, "Failed")); }
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <h1 className="font-display text-2xl font-black">Live Sports · TV Scheduling</h1>
        <span className="text-[10px] font-mono uppercase text-[var(--muted)] border border-[var(--border)] rounded px-2 py-1">All times HKT</span>
        <div className="ml-auto flex gap-2">
          {isManager && <button data-testid="btn-add-screen" onClick={addScreen} className="px-3 py-2 rounded-lg text-xs uppercase flex items-center gap-2 bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--cyan)]"><Tv size={14} /> Add Screen</button>}
          {isManager && <button data-testid="btn-schedule" onClick={() => setForm({ screen_id: screens[0]?.id || "", channel: "", event_title: "", sport: "", start: "", end: "" })} className="btn-neon px-4 py-2 rounded-lg text-xs uppercase flex items-center gap-2"><Plus size={14} /> Schedule</button>}
        </div>
      </div>

      <div className="flex gap-1 mb-4 p-1 bg-[var(--surface-2)] rounded-lg w-fit">
        {[["board", "Now / Next Board"], ["schedule", "Full Schedule"], ["feed", "Fixtures Feed"]].map(([v, l]) => (
          <button key={v} data-testid={`tab-${v}`} onClick={() => setTab(v)} className={`px-4 py-2 rounded-md text-sm font-semibold ${tab === v ? "bg-[var(--cyan)] text-black" : "text-[var(--muted)]"}`}>{l}</button>
        ))}
      </div>

      {tab === "board" && (
        <div className="grid grid-cols-3 gap-3">
          {board.map(({ screen, now, next }) => (
            <div key={screen.id} data-testid={`board-screen-${screen.name}`} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
              <div className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-2">
                <Tv size={16} className="text-[var(--cyan)]" />
                <div className="font-display font-black">{screen.name}</div>
                {isManager && <button onClick={() => delScreen(screen)} className="ml-auto text-[var(--muted)] hover:text-[var(--rose)]"><Trash2 size={13} /></button>}
              </div>
              <div className="p-4 space-y-3">
                <div>
                  <div className="text-[10px] font-mono uppercase text-[var(--emerald)] flex items-center gap-1 mb-1"><Radio size={11} /> Now</div>
                  {now ? (
                    <div className="p-2 rounded bg-[var(--emerald)]/10 border border-[var(--emerald)]/30">
                      <div className="font-semibold text-sm">{now.event_title}</div>
                      <div className="text-[10px] font-mono text-[var(--muted)]">{now.channel || "—"} · {now.sport || ""}</div>
                    </div>
                  ) : <div className="text-xs text-[var(--muted)] italic">Nothing scheduled</div>}
                </div>
                <div>
                  <div className="text-[10px] font-mono uppercase text-[var(--amber)] flex items-center gap-1 mb-1"><CalendarClock size={11} /> Next</div>
                  {next ? (
                    <div className="p-2 rounded bg-[var(--surface-2)] border border-[var(--border)]">
                      <div className="font-semibold text-sm">{next.event_title}</div>
                      <div className="text-[10px] font-mono text-[var(--muted)]">{next.channel || "—"} · {fmtHKT(next.start)}</div>
                    </div>
                  ) : <div className="text-xs text-[var(--muted)] italic">No upcoming booking</div>}
                </div>
              </div>
            </div>
          ))}
          {board.length === 0 && <div className="col-span-3 p-10 rounded-xl border border-dashed border-[var(--border)] text-center text-[var(--muted)]">No screens yet — add a TV.</div>}
        </div>
      )}

      {tab === "schedule" && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
          {broadcasts.map(b => (
            <div key={b.id} data-testid={`bc-row-${b.id}`} className="px-4 py-3 flex items-center gap-3">
              <span className={`w-2 h-2 rounded-full ${b.live ? "bg-[var(--emerald)]" : b.upcoming ? "bg-[var(--amber)]" : "bg-[var(--muted)]"}`} />
              <div className="flex-1">
                <div className="font-semibold text-sm">{b.event_title} <span className="text-[10px] font-mono text-[var(--muted)]">· {b.screen_name}</span></div>
                <div className="text-[10px] font-mono text-[var(--muted)]">{b.channel || "no channel"} · {b.sport || ""} · {fmtHKT(b.start_hkt || b.start)} → {new Date(b.end_hkt || b.end).toLocaleTimeString("en-HK", { timeZone: "Asia/Hong_Kong", hour12: false, hour: "2-digit", minute: "2-digit" })}</div>
              </div>
              {b.live && <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-[var(--emerald)] text-black font-black">LIVE</span>}
              {isManager && <button data-testid={`bc-del-${b.id}`} onClick={() => delBroadcast(b)} className="text-[var(--muted)] hover:text-[var(--rose)]"><Trash2 size={14} /></button>}
            </div>
          ))}
          {broadcasts.length === 0 && <div className="p-10 text-center text-[var(--muted)]">No bookings scheduled.</div>}
        </div>
      )}

      {tab === "feed" && <FixturesFeed onSchedule={(fx) => setForm({ screen_id: screens[0]?.id || "", channel: "", event_title: fx.title, sport: fx.sport, fixture_id: fx.fixture_id, start: hktInput(fx.start_hkt), end: hktInput(fx.start_hkt, 2) })} />}

      {form && <ScheduleModal form={form} setForm={setForm} screens={screens} onClose={() => setForm(null)} onSaved={() => { setForm(null); load(); }} />}
    </div>
  );
}

function hktInput(iso, addHours = 0) {
  if (!iso) return "";
  const d = new Date(iso); d.setHours(d.getHours() + addHours);
  // Build a datetime-local string in HKT
  const hk = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Hong_Kong" }));
  const pad = (n) => String(n).padStart(2, "0");
  return `${hk.getFullYear()}-${pad(hk.getMonth() + 1)}-${pad(hk.getDate())}T${pad(hk.getHours())}:${pad(hk.getMinutes())}`;
}

function ScheduleModal({ form, setForm, screens, onClose, onSaved }) {
  const [conflicts, setConflicts] = useState([]);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const save = async () => {
    if (!form.screen_id || !form.event_title || !form.start || !form.end) return toast.error("Screen, event, start & end required");
    const body = { screen_id: form.screen_id, channel: form.channel, event_title: form.event_title, sport: form.sport, fixture_id: form.fixture_id || null, start: hktToUtc(form.start), end: hktToUtc(form.end) };
    try {
      const r = await api.post("/broadcasts", body);
      if (r.data.conflicts?.length) { setConflicts(r.data.conflicts); toast.warning(`Scheduled with ${r.data.conflicts.length} overlap warning(s)`); setTimeout(onSaved, 1500); }
      else { toast.success("Broadcast scheduled"); onSaved(); }
    } catch (e) { toast.error(errMsg(e, "Manager only")); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-4"><CalendarClock size={18} className="text-[var(--cyan)]" /><div className="font-display font-black text-xl">Schedule Broadcast</div><button onClick={onClose} className="ml-auto text-[var(--muted)]"><X size={18} /></button></div>
        <div className="space-y-3">
          <F label="Screen"><select data-testid="sch-screen" value={form.screen_id} onChange={e => set("screen_id", e.target.value)} className="inp">{screens.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></F>
          <F label="Event / match"><input data-testid="sch-event" value={form.event_title} onChange={e => set("event_title", e.target.value)} className="inp" placeholder="Man Utd vs Arsenal" /></F>
          <div className="grid grid-cols-2 gap-3">
            <F label="Channel (HK broadcaster)"><input data-testid="sch-channel" value={form.channel} onChange={e => set("channel", e.target.value)} className="inp" placeholder="Now Sports 631" /></F>
            <F label="Sport"><input data-testid="sch-sport" value={form.sport} onChange={e => set("sport", e.target.value)} className="inp" placeholder="Football" /></F>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <F label="Start (HKT)"><input data-testid="sch-start" type="datetime-local" value={form.start} onChange={e => set("start", e.target.value)} className="inp" /></F>
            <F label="End (HKT)"><input data-testid="sch-end" type="datetime-local" value={form.end} onChange={e => set("end", e.target.value)} className="inp" /></F>
          </div>
          {conflicts.length > 0 && (
            <div data-testid="sch-conflicts" className="p-2 rounded-lg bg-[var(--rose)]/10 border border-[var(--rose)]/40 text-xs text-[var(--rose)] flex items-start gap-2">
              <AlertTriangle size={14} /> <div>Overlaps: {conflicts.map(c => c.event_title).join(", ")} — scheduled anyway (warning only).</div>
            </div>
          )}
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-lg bg-[var(--surface-2)]">Cancel</button>
          <button data-testid="sch-save" onClick={save} className="flex-1 btn-neon py-2.5 rounded-lg">Schedule</button>
        </div>
      </div>
    </div>
  );
}

function FixturesFeed({ onSchedule }) {
  const [leagues, setLeagues] = useState([]);
  const [key, setKey] = useState("epl");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => { api.get("/fixtures/leagues").then(r => setLeagues(r.data)); }, []);
  useEffect(() => {
    setLoading(true);
    api.get("/fixtures", { params: { league_key: key } }).then(r => setData(r.data)).catch(() => setData({ fixtures: [], manual_only: true })).finally(() => setLoading(false));
  }, [key]);
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-center gap-2 mb-3">
        <Rss size={16} className="text-[var(--purple)]" />
        <div className="font-display font-black">Fixtures Feed <span className="text-[10px] font-mono text-[var(--muted)]">· TheSportsDB · HKT</span></div>
        <select data-testid="feed-league" value={key} onChange={e => setKey(e.target.value)} className="ml-auto inp w-64">
          {leagues.map(l => <option key={l.key} value={l.key}>{l.name}{l.manual_only ? " (manual)" : ""}</option>)}
        </select>
      </div>
      {loading && <div className="text-[var(--muted)] text-sm py-6 text-center">Loading fixtures…</div>}
      {!loading && data?.manual_only && (
        <div className="p-4 rounded-lg border border-dashed border-[var(--amber)]/40 bg-[var(--amber)]/5 text-sm text-[var(--amber)] flex items-center gap-2">
          <AlertTriangle size={16} /> Thin/no feed coverage for this competition — use the Schedule button to enter it manually.
        </div>
      )}
      {!loading && !data?.manual_only && (
        <div className="space-y-1.5">
          {(data?.fixtures || []).map(fx => (
            <div key={fx.fixture_id} data-testid={`fixture-${fx.fixture_id}`} className="p-3 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] flex items-center gap-3">
              <div className="flex-1">
                <div className="font-semibold text-sm">{fx.title}</div>
                <div className="text-[10px] font-mono text-[var(--muted)]">{fx.league} · {fmtHKT(fx.start_hkt)}{fx.venue ? ` · ${fx.venue}` : ""}</div>
              </div>
              <button data-testid={`fixture-schedule-${fx.fixture_id}`} onClick={() => onSchedule(fx)} className="btn-neon px-3 py-1.5 rounded-lg text-xs uppercase">Assign to TV</button>
            </div>
          ))}
          {(data?.fixtures || []).length === 0 && <div className="text-[var(--muted)] text-sm py-6 text-center">No upcoming fixtures returned — try another league or enter manually.</div>}
        </div>
      )}
    </div>
  );
}

const F = ({ label, children }) => (
  <div><label className="text-[10px] font-mono uppercase text-[var(--muted)] block mb-1">{label}</label>{children}</div>
);
