import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";

/** Active happy-hour windows (server-computed, refreshed every minute) + HH pricing helpers. */
export function useHappyHour() {
  const [activeHH, setActiveHH] = useState([]);

  useEffect(() => {
    const loadHH = () => api.get("/happy-hours/active").then((r) => setActiveHH(r.data.active || []));
    loadHH();
    const t = setInterval(loadHH, 60000);
    return () => clearInterval(t);
  }, []);

  // Best HH percent for a product (only HH-eligible products, matched by category)
  const hhFor = useCallback((p) => {
    if (!p?.happy_hour_eligible) return 0;
    let best = 0;
    for (const h of activeHH) {
      if ((h.category_ids || []).includes(p.category_id)) {
        best = Math.max(best, h.percent_off || 0);
      }
    }
    return best;
  }, [activeHH]);

  const hhPrice = useCallback((p, base = p.price) => {
    const pct = hhFor(p);
    return pct ? +(base * (1 - pct / 100)).toFixed(2) : base;
  }, [hhFor]);

  return { activeHH, hhFor, hhPrice };
}
