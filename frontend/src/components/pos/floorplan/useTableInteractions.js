import { useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";

/** Edit-mode table interactions: drag-to-move, corner-drag resize, style changes. */
export function useTableInteractions(tables, setTables, editMode) {
  const [drag, setDrag] = useState(null);
  const [resize, setResize] = useState(null);

  const onDown = (e, t) => {
    if (!editMode) return;
    const rect = e.currentTarget.parentElement.getBoundingClientRect();
    setDrag({ id: t.id, startX: e.clientX, startY: e.clientY, x0: t.x, y0: t.y, rect });
  };

  const onResizeDown = (e, t) => {
    if (!editMode) return;
    setResize({ id: t.id, startX: e.clientX, startY: e.clientY, w0: t.width, h0: t.height, shape: t.shape });
  };

  const onMove = (e) => {
    if (resize) {
      const dx = e.clientX - resize.startX;
      const dy = e.clientY - resize.startY;
      const w = Math.min(400, Math.max(60, resize.w0 + dx));
      const h = resize.shape === "circle" ? w : Math.min(400, Math.max(60, resize.h0 + dy));
      setTables((ts) => ts.map((t) => (t.id === resize.id ? { ...t, width: Math.round(w), height: Math.round(h) } : t)));
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    setTables((ts) => ts.map((t) => (t.id === drag.id ? { ...t, x: Math.max(0, drag.x0 + dx), y: Math.max(0, drag.y0 + dy) } : t)));
  };

  const onUp = async () => {
    if (resize) {
      const t = tables.find((x) => x.id === resize.id);
      setResize(null);
      if (!t) return;
      try {
        await api.patch(`/tables/${t.id}`, { width: t.width, height: t.height });
      } catch {
        toast.error("Failed to save size");
      }
      return;
    }
    if (!drag) return;
    const t = tables.find((x) => x.id === drag.id);
    setDrag(null);
    if (!t) return;
    try {
      await api.patch(`/tables/${t.id}`, { x: t.x, y: t.y });
    } catch {
      toast.error("Failed to save position");
    }
  };

  const onStyleChange = (id, body) => {
    setTables((ts) => ts.map((t) => {
      if (t.id !== id) return t;
      const next = { ...t, ...body };
      if (body.clear_color) next.color = null;
      delete next.clear_color;
      return next;
    }));
  };

  return { onDown, onResizeDown, onMove, onUp, onStyleChange };
}
