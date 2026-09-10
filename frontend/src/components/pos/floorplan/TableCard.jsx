import { useState } from "react";
import { Users as UsersIcon, Trash2, TrendingUp } from "lucide-react";
import { api, fmtHKD } from "@/lib/api";
import ResCountdown from "./ResCountdown";

const STATUS_COLORS = {
  available: "border-[var(--emerald)]/60 bg-[var(--emerald)]/5 text-[var(--emerald)]",
  occupied:  "border-[var(--rose)]/60    bg-[var(--rose)]/10    text-[var(--rose)]",
  reserved:  "border-[var(--purple)]/60  bg-[var(--purple)]/10  text-[var(--purple)]",
  dirty:     "border-[var(--amber)]/60   bg-[var(--amber)]/10   text-[var(--amber)]",
  out_of_service: "border-[var(--muted)]/60 bg-[var(--surface)] text-[var(--muted)]",
};

export const TABLE_COLORS = ["#00F2FE", "#FFB800", "#10B981", "#F43F5E", "#A855F7", "#F59E0B", "#EC4899", "#94A3B8"];
export const COLOR_MODES = [["border", "Border"], ["fill", "Fill"], ["both", "Both"]];

/** Custom color overrides the status border/fill styling. mode: border | fill | both */
export function tableStyle(t) {
  if (!t.color) return {};
  const mode = t.color_mode || "border";
  const s = {};
  if (mode === "border" || mode === "both") s.borderColor = t.color;
  if (mode === "fill" || mode === "both") s.backgroundColor = `${t.color}2E`; // ~18% alpha fill
  return s;
}

/**
 * Draggable + clickable table card with combo heat-map glow.
 * Extracted from Floorplan.jsx during the component-split sprint.
 */
export default function TableCard({ table: t, hint, editMode, onDown, onResizeDown, openTable, delTable, onStyleChange }) {
  return (
    <div
      key={t.id}
      data-testid={`table-${t.name}`}
      onMouseDown={(e) => onDown(e, t)}
      onClick={() => openTable(t)}
      className={`absolute border-2 ${STATUS_COLORS[t.status]} ${
        t.shape === "circle" ? "rounded-full" : "rounded-lg"
      } select-none flex flex-col items-center justify-center p-2 transition-transform hover:scale-105 ${
        editMode ? "cursor-move" : "cursor-pointer"
      } ${hint ? "ring-2 ring-[var(--cyan)] ring-offset-2 ring-offset-[var(--surface)]" : ""}`}
      style={{
        left: t.x, top: t.y, width: t.width, height: t.height,
        boxShadow: hint ? "0 0 24px rgba(0,242,254,0.55)" : undefined,
        ...tableStyle(t),
      }}
    >
      <div className="font-display font-black text-lg">{t.name}</div>
      <div className="flex items-center gap-1 text-[10px] font-mono opacity-80">
        <UsersIcon size={10} /> {t.seats}
      </div>
      {t.current_order && (
        <div className="font-mono text-[11px] font-bold mt-0.5">
          {fmtHKD(t.current_order.total)}
        </div>
      )}
      {hint && (
        <div data-testid={`combo-hint-${t.name}`}
          className="absolute -top-2 left-1/2 -translate-x-1/2 whitespace-nowrap px-1.5 py-0.5 rounded-full bg-[var(--cyan)] text-black text-[9px] font-mono font-black flex items-center gap-0.5 shadow-lg">
          <TrendingUp size={9} /> +1 {hint.product_name?.split(" ")[0]} → -{hint.discount_type === "percent" ? `${hint.discount_value}%` : fmtHKD(hint.discount)}
        </div>
      )}
      {t.reservation && t.status === "reserved" && (
        <div className="text-[9px] font-mono opacity-80 leading-tight text-center px-1">
          <div className="truncate max-w-[80px]">{t.reservation.guest_name}</div>
          <ResCountdown iso={t.reservation.reserved_for} />
        </div>
      )}
      {editMode && (
        <TableEditControls t={t} onResizeDown={onResizeDown} delTable={delTable} onStyleChange={onStyleChange} />
      )}
    </div>
  );
}

/** Edit-mode chrome: delete, resize handle, shape toggle, color picker + palette. */
function TableEditControls({ t, onResizeDown, delTable, onStyleChange }) {
  const [palette, setPalette] = useState(false);

  const saveStyle = async (body) => {
    onStyleChange(t.id, body);
    setPalette(false);
    try {
      await api.patch(`/tables/${t.id}`, body);
    } catch (err) {
      // Optimistic UI already applied; keep it but surface the failure.
      console.warn(`[table] style save failed for ${t.name}:`, err?.response?.status || err.message);
    }
  };

  return (
    <>
      <button
        data-testid={`btn-del-${t.name}`}
        onClick={(e) => { e.stopPropagation(); delTable(t.id); }}
        className="absolute -top-2 -right-2 w-6 h-6 bg-[var(--rose)] text-white rounded-full flex items-center justify-center"
      >
        <Trash2 size={12} />
      </button>
      {/* resize handle — pull to adjust size/dimensions */}
      <div
        data-testid={`resize-${t.name}`}
        onMouseDown={(e) => { e.stopPropagation(); onResizeDown(e, t); }}
        onClick={(e) => e.stopPropagation()}
        title="Drag to resize"
        className="absolute -bottom-2 -right-2 w-6 h-6 rounded-full bg-[var(--amber)] text-black flex items-center justify-center cursor-nwse-resize shadow-lg border-2 border-[var(--surface)]"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M9 1L1 9M9 5L5 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
      {/* shape toggle */}
      <button
        data-testid={`shape-${t.name}`}
        onClick={async (e) => {
          e.stopPropagation();
          const shape = t.shape === "circle" ? "rect" : "circle";
          const body = { shape };
          if (shape === "circle") body.height = t.width; // round tables stay square-ish
          onStyleChange(t.id, body);
          await api.patch(`/tables/${t.id}`, body).catch((err) => console.warn("[table] shape save failed:", err));
        }}
        onMouseDown={(e) => e.stopPropagation()}
        title="Toggle round / square"
        className="absolute -bottom-2 -left-2 w-6 h-6 rounded-full bg-[var(--surface-2)] border border-[var(--border)] text-[10px] flex items-center justify-center"
      >
        {t.shape === "circle" ? "◯" : "▢"}
      </button>
      {/* color picker toggle */}
      <button
        data-testid={`color-${t.name}`}
        onClick={(e) => { e.stopPropagation(); setPalette((p) => !p); }}
        onMouseDown={(e) => e.stopPropagation()}
        title="Table color"
        className="absolute -top-2 -left-2 w-6 h-6 rounded-full border-2 border-[var(--surface)] shadow-lg"
        style={{ background: t.color || "var(--surface-2)" }}
      />
      {palette && <TableColorPalette t={t} onSave={saveStyle} />}
    </>
  );
}

function TableColorPalette({ t, onSave }) {
  return (
    <div
      data-testid={`palette-${t.name}`}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute top-full left-0 mt-2 z-50 p-2 rounded-xl bg-[var(--surface-2)] border border-[var(--border)] shadow-2xl w-44"
    >
      <div className="grid grid-cols-4 gap-1.5 mb-2">
        {TABLE_COLORS.map((c) => (
          <button key={c} data-testid={`palette-color-${c.replace("#", "")}`}
            onClick={() => onSave({ color: c, color_mode: t.color_mode || "border" })}
            className={`w-8 h-8 rounded-md border-2 ${t.color === c ? "border-white" : "border-transparent"}`}
            style={{ background: c }} />
        ))}
      </div>
      <div className="flex gap-1">
        {COLOR_MODES.map(([m, label]) => (
          <button key={m} data-testid={`palette-mode-${m}`}
            onClick={() => t.color && onSave({ color: t.color, color_mode: m })}
            className={`flex-1 py-1 rounded-md text-[9px] font-mono font-bold uppercase ${
              (t.color_mode || "border") === m ? "bg-[var(--cyan)] text-black" : "bg-[var(--surface)] text-[var(--muted)]"}`}>
            {label}
          </button>
        ))}
      </div>
      <button data-testid={`palette-clear-${t.name}`} onClick={() => onSave({ clear_color: true })}
        className="mt-1.5 w-full py-1 rounded-md text-[9px] font-mono uppercase text-[var(--rose)] bg-[var(--rose)]/10">
        Clear color
      </button>
    </div>
  );
}
