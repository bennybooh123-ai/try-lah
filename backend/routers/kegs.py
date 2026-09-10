"""Kegs router — 35+ tap tracker with volume, cost/size intelligence, blown variance,
and low-level alerts. Pour presets per variant drive automatic stock deduction."""
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from deps import db, _oid, serialize, MANAGER_ROLES
from auth import make_current_user_dep

get_current_user = make_current_user_dep(lambda: db)

router = APIRouter(prefix="/api", tags=["kegs"])

POUR_PRESETS = [50, 100, 150, 250, 300, 400, 600]  # ml tap-chip picker


class KegIn(BaseModel):
    name: str
    product_id: str
    size_ml: int = 30000        # 30L standard HK keg
    ml_per_pour: int = 568      # default pour (UK pint) — fallback when a variant has no pour_ml
    threshold_pct: float = 10.0
    cost: float = 0.0           # HKD purchase cost of the keg
    supplier: Optional[str] = ""
    purchase_date: Optional[str] = None
    install_date: Optional[str] = None


def _keg_metrics(k: dict, actual_pours: int) -> dict:
    """cost_per_pour + theoretical/actual pours + blown variance %."""
    size = k.get("size_ml") or 0
    pour = k.get("ml_per_pour") or 568
    cost = k.get("cost") or 0.0
    theo = int(size / pour) if pour else 0
    cost_per_pour = round(cost / theo, 2) if theo else 0.0
    # Beer physically gone converted to pours vs pours we actually rang up
    dispensed_ml = max(0, size - (k.get("current_ml") or 0))
    expected_from_dispensed = int(dispensed_ml / pour) if pour else 0
    variance_pours = expected_from_dispensed - actual_pours
    variance_pct = round(100 * variance_pours / theo, 1) if theo else 0.0
    return {
        "theoretical_pours": theo,
        "actual_pours": actual_pours,
        "cost_per_pour": cost_per_pour,
        "variance_pct": variance_pct,
        "variance_high": abs(variance_pct) > 5.0,
    }


async def _actual_pours_by_keg() -> dict:
    counts: dict = {}
    for row in await db.keg_pours.aggregate([
        {"$group": {"_id": "$keg_id", "n": {"$sum": "$qty"}}}
    ]).to_list(1000):
        counts[row["_id"]] = int(row.get("n") or 0)
    return counts


@router.get("/kegs/pour-presets")
async def pour_presets(user: dict = Depends(get_current_user)):
    return {"presets_ml": POUR_PRESETS}


@router.get("/kegs")
async def list_kegs(user: dict = Depends(get_current_user)):
    docs = await db.kegs.find().sort("name", 1).to_list(200)
    prods = {str(p["_id"]): p for p in await db.products.find().to_list(2000)}
    pours = await _actual_pours_by_keg()
    out = []
    for d in docs:
        s = serialize(d)
        s["product"] = serialize(prods.get(d.get("product_id"))) if prods.get(d.get("product_id")) else None
        pct = 0
        if s.get("size_ml"):
            pct = round(100 * (s.get("current_ml", 0) or 0) / s["size_ml"], 1)
        s["pct_remaining"] = pct
        s["alert"] = pct <= s.get("threshold_pct", 10) and s.get("status") == "on"
        s["pours_remaining"] = int((s.get("current_ml", 0) or 0) / (s.get("ml_per_pour") or 568))
        s.update(_keg_metrics(d, pours.get(str(d["_id"]), 0)))
        out.append(s)
    return out


@router.post("/kegs")
async def create_keg(body: KegIn, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")   # keg cost is financial data
    doc = body.model_dump()
    doc.update({
        "current_ml": body.size_ml,
        "status": "on",
        "opened_at": datetime.now(timezone.utc).isoformat(),
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    r = await db.kegs.insert_one(doc)
    doc["_id"] = r.inserted_id
    return serialize(doc)


@router.patch("/kegs/{kid}")
async def update_keg(kid: str, body: KegIn, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")   # keg cost is financial data
    await db.kegs.update_one({"_id": _oid(kid)}, {"$set": body.model_dump()})
    return serialize(await db.kegs.find_one({"_id": _oid(kid)}))


@router.post("/kegs/{kid}/new")
async def install_new_keg(kid: str, user: dict = Depends(get_current_user)):
    """Mark a keg as freshly changed — reset volume and status; clear pour history."""
    k = await db.kegs.find_one({"_id": _oid(kid)})
    if not k:
        raise HTTPException(404, "Not found")
    await db.keg_pours.delete_many({"keg_id": kid})  # fresh keg -> fresh variance baseline
    await db.kegs.update_one(
        {"_id": _oid(kid)},
        {"$set": {
            "current_ml": k["size_ml"],
            "status": "on",
            "opened_at": datetime.now(timezone.utc).isoformat(),
            "install_date": datetime.now(timezone.utc).date().isoformat(),
        }},
    )
    return serialize(await db.kegs.find_one({"_id": _oid(kid)}))


@router.post("/kegs/{kid}/blown")
async def mark_blown(kid: str, user: dict = Depends(get_current_user)):
    k = await db.kegs.find_one({"_id": _oid(kid)})
    if not k:
        raise HTTPException(404, "Not found")
    pours = await _actual_pours_by_keg()
    metrics = _keg_metrics(k, pours.get(kid, 0))
    await db.kegs.update_one({"_id": _oid(kid)}, {"$set": {
        "status": "blown", "current_ml": 0,
        "blown_at": datetime.now(timezone.utc).isoformat(),
        "blown_variance_pct": metrics["variance_pct"],
    }})
    return serialize(await db.kegs.find_one({"_id": _oid(kid)}))


@router.delete("/kegs/{kid}")
async def delete_keg(kid: str, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    await db.kegs.delete_one({"_id": _oid(kid)})
    return {"ok": True}


def _pour_ml_for_line(line: dict, product: dict | None, keg: dict) -> int:
    """Variant's configured pour size wins; else the keg default pour."""
    if product:
        for v in product.get("variants") or []:
            if v.get("name") == line.get("variant") and v.get("pour_ml"):
                return int(v["pour_ml"])
    return int(keg.get("ml_per_pour") or 568)


async def decrement_kegs_for_order(order: dict):
    """Subtract ml per pour for every line matching an on-tap keg. Pour volume comes
    from the sold variant's preset (falls back to the keg default). Drains the
    lowest-current_ml keg first so the near-empty tap blows before the backup.
    Every pour is logged to keg_pours for velocity + variance analytics."""
    kegs = await db.kegs.find({"status": "on"}).to_list(200)
    kegs.sort(key=lambda k: (k.get("current_ml") or 0))
    by_pid = {}
    for k in kegs:
        by_pid.setdefault(k["product_id"], k)
    prods = {str(p["_id"]): p for p in await db.products.find().to_list(2000)}
    now_iso = datetime.now(timezone.utc).isoformat()
    pour_docs = []
    for l in order.get("lines", []):
        pid = l.get("product_id")
        if pid not in by_pid:
            continue
        k = by_pid[pid]
        qty = l.get("qty") or 1
        pour_ml = _pour_ml_for_line(l, prods.get(pid), k)
        pour = pour_ml * qty
        new_ml = max(0, (k.get("current_ml") or 0) - pour)
        upd = {"current_ml": new_ml}
        if new_ml == 0:
            upd["status"] = "blown"
        await db.kegs.update_one({"_id": k["_id"]}, {"$set": upd})
        k["current_ml"] = new_ml
        pour_docs.append({
            "keg_id": str(k["_id"]), "product_id": pid,
            "ml": pour, "pour_ml": pour_ml, "qty": qty, "at": now_iso,
        })
    if pour_docs:
        await db.keg_pours.insert_many(pour_docs)


@router.get("/kegs/{kid}/pours")
async def keg_pours(kid: str, days: int = 7, user: dict = Depends(get_current_user)):
    """Return per-day pour volume for the last N days (default 7)."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    docs = await db.keg_pours.find({"keg_id": kid, "at": {"$gte": since}}).to_list(5000)
    by_day: dict = {}
    for d in docs:
        day = d["at"][:10]  # YYYY-MM-DD
        by_day[day] = by_day.get(day, 0) + (d.get("ml") or 0)
    out = []
    for i in range(days - 1, -1, -1):
        day = (datetime.now(timezone.utc) - timedelta(days=i)).date().isoformat()
        out.append({"day": day, "ml": by_day.get(day, 0), "pints": round(by_day.get(day, 0) / 568, 1)})
    total_ml = sum(d["ml"] for d in out)
    return {"days": out, "total_ml": total_ml, "total_pints": round(total_ml / 568, 1)}


@router.get("/kegs/variance-report")
async def variance_report(days: int = 7, user: dict = Depends(get_current_user)):
    """Weekly overpour/spillage summary. Every keg's theoretical vs actual pours,
    variance %, and estimated cost loss. Blown kegs within the window are highlighted."""
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    docs = await db.kegs.find().sort("name", 1).to_list(500)
    prods = {str(p["_id"]): p for p in await db.products.find().to_list(2000)}
    pours = await _actual_pours_by_keg()
    rows, total_loss, high = [], 0.0, 0
    for d in docs:
        m = _keg_metrics(d, pours.get(str(d["_id"]), 0))
        blown = d.get("status") == "blown"
        in_window = not blown or (d.get("blown_at", "") >= since)
        if not in_window:
            continue
        est_loss = round((m["variance_pct"] / 100.0) * (d.get("cost") or 0), 2)
        if m["variance_high"]:
            high += 1
            total_loss += max(0.0, est_loss)
        rows.append({
            "id": str(d["_id"]), "name": d.get("name"),
            "product": (prods.get(d.get("product_id")) or {}).get("name", "—"),
            "status": d.get("status"), "blown_at": d.get("blown_at"),
            "size_ml": d.get("size_ml"), "cost": d.get("cost", 0),
            "theoretical_pours": m["theoretical_pours"], "actual_pours": m["actual_pours"],
            "variance_pct": m["variance_pct"], "variance_high": m["variance_high"],
            "est_loss": est_loss,
        })
    rows.sort(key=lambda r: -abs(r["variance_pct"]))
    return {
        "days": days,
        "kegs": rows,
        "blown_count": sum(1 for r in rows if r["status"] == "blown"),
        "high_variance_count": high,
        "total_est_loss": round(total_loss, 2),
    }


@router.post("/kds/prep/bump")
async def prep_bump_all(product_id: str, user: dict = Depends(get_current_user)):
    """Bump every fired-not-bumped line matching product_id across all open orders."""
    orders = await db.orders.find({"status": "open"}).to_list(500)
    bumped = 0
    now_iso = datetime.now(timezone.utc).isoformat()
    for o in orders:
        lines = o.get("lines", [])
        changed = False
        for l in lines:
            if l.get("product_id") == product_id and l.get("fired_at") and not l.get("bumped_at") and not l.get("held"):
                l["bumped_at"] = now_iso
                l["bumped_by"] = user["id"]
                bumped += 1
                changed = True
        if changed:
            await db.orders.update_one({"_id": o["_id"]}, {"$set": {"lines": lines}})
    return {"bumped": bumped}


def _acc_prep_line(prep: dict, l: dict, tname: str, prods: dict):
    """Fold one fired line into the per-product prep accumulator."""
    key = l.get("product_id") or l["name"]
    if key not in prep:
        p = prods.get(l.get("product_id") or "")
        prep[key] = {
            "product_id": l.get("product_id"),
            "name": (p or {}).get("name") or l["name"],
            "kind": (p or {}).get("kind") or ("drink" if l.get("course") == "drink" else "food"),
            "course": l.get("course"),
            "total": 0,
            "tables": {},
        }
    qty = l.get("qty") or 1
    prep[key]["total"] += qty
    prep[key]["tables"][tname] = prep[key]["tables"].get(tname, 0) + qty


# ---------- Prep view (consolidated kitchen batch) ----------
@router.get("/kds/prep")
async def prep_view(user: dict = Depends(get_current_user)):
    """Group fired items across open orders by product — kitchen bulk-cook view."""
    orders = await db.orders.find({"status": "open"}).to_list(500)
    tables = {str(t["_id"]): t for t in await db.tables.find().to_list(500)}
    prods = {str(p["_id"]): p for p in await db.products.find().to_list(2000)}
    prep: dict = {}
    for o in orders:
        raw_name = tables.get(o.get("table_id") or "", {}).get("name")
        tname = raw_name or (o.get("order_type", "") or "").upper() or "—"
        for l in o.get("lines", []):
            if l.get("held") or not l.get("fired_at") or l.get("bumped_at"):
                continue
            _acc_prep_line(prep, l, tname, prods)
    out = [
        {**v, "tables": [{"name": k, "qty": q} for k, q in sorted(v["tables"].items(), key=lambda x: -x[1])]}
        for v in prep.values()
    ]
    out.sort(key=lambda x: -x["total"])
    return out
