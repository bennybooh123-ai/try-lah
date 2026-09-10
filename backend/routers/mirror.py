"""Cloud reporting mirror — read-only owner dashboard sync.

On-prem POS pushes aggregated sales + inventory OUT to the cloud service
(CLOUD_MIRROR_URL). The cloud never calls in; no inbound hole into the store
network. Internet outage does not stop service — sync just resumes.
"""
import asyncio
import os
from datetime import datetime, timezone

import requests
from fastapi import APIRouter, Depends, HTTPException

from deps import db, sl, MANAGER_ROLES
from auth import make_current_user_dep

get_current_user = make_current_user_dep(lambda: db)
router = APIRouter(prefix="/api/cloud", tags=["cloud"])

CLOUD_URL = os.environ.get("CLOUD_MIRROR_URL", "http://localhost:8002")
CLOUD_KEY = os.environ.get("CLOUD_API_KEY", "")
SYNC_INTERVAL = int(os.environ.get("SYNC_INTERVAL_SECONDS", "120"))


def _now():
    return datetime.now(timezone.utc).isoformat()


def _sales_summary(paid: list) -> dict:
    """Aggregate paid orders into the mirror's sales block."""
    by_hour: dict = {}
    by_pay: dict = {}
    for o in paid:
        try:
            h = datetime.fromisoformat(o["closed_at"]).astimezone(timezone.utc).hour
        except Exception:
            h = 0
        by_hour[h] = round(by_hour.get(h, 0) + o.get("total", 0), 2)
        m = (o.get("payment") or {}).get("method", "cash")
        by_pay[m] = round(by_pay.get(m, 0) + o.get("total", 0), 2)
    return {
        "total_revenue": round(sum(o.get("total", 0) for o in paid), 2),
        "paid_orders": len(paid),
        "by_hour": [{"hour": h, "revenue": v} for h, v in sorted(by_hour.items())],
        "by_payment": [{"method": k, "amount": v} for k, v in by_pay.items()],
    }


async def _usage_summary() -> list:
    rows = await db.inv_movements.find({"type": "sale"}).to_list(10000)
    usage: dict = {}
    for r in rows:
        usage[r["name"]] = round(usage.get(r["name"], 0) - r["delta"], 3)
    return [{"name": k, "qty": v} for k, v in usage.items()]


async def _briefing(low: list) -> dict:
    """Pre-shift briefing: low stock, 86'd items, today's events."""
    eightysixed = [p["name"] async for p in db.products.find({"eightysix": True})]
    events_today = []
    try:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        async for e in db.events.find({"date": today}):
            events_today.append(e.get("name", "event"))
    except Exception:
        pass
    return {"low_stock": [i["name"] for i in low], "eightysixed": eightysixed, "events_today": events_today}


async def build_payload() -> dict:
    paid = await db.orders.find({"status": "paid"}).to_list(5000)
    ingredients = sl(await db.ingredients.find().to_list(500))
    low = [i for i in ingredients if i["qty"] <= i.get("par_level", 0)]
    unacked = await db.alerts.find({"ack": False}).sort("ts", -1).to_list(20)
    return {
        "venue_id": "hk-bar-001",
        "ts": _now(),
        "sales": _sales_summary(paid),
        "inventory": [{"name": i["name"], "qty": i["qty"], "unit": i["unit"], "par_level": i.get("par_level", 0)} for i in ingredients],
        "low_stock": [i["name"] for i in low],
        "usage": await _usage_summary(),
        "briefing": await _briefing(low),
        "alerts": [{"kind": a.get("kind"), "message": a.get("message"), "ts": a.get("ts")} for a in unacked],
    }


async def push_to_cloud() -> dict:
    payload = await build_payload()

    def _post():
        return requests.post(f"{CLOUD_URL}/cloud/api/ingest", json=payload,
                             headers={"X-API-Key": CLOUD_KEY}, timeout=10)

    resp = await asyncio.to_thread(_post)
    resp.raise_for_status()
    await db.settings.update_one({"key": "mirror"}, {"$set": {"last_sync": _now(), "last_sync_status": "ok"}}, upsert=True)
    return {"ok": True, "ts": payload["ts"]}


@router.post("/sync")
async def sync_now(user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    try:
        return await push_to_cloud()
    except Exception as e:
        await db.settings.update_one({"key": "mirror"}, {"$set": {"last_sync": _now(), "last_sync_status": f"error: {e}"}}, upsert=True)
        raise HTTPException(502, f"Cloud sync failed: {e}")


@router.get("/status")
async def sync_status(user: dict = Depends(get_current_user)):
    s = await db.settings.find_one({"key": "mirror"}) or {}
    return {"mirror_url": CLOUD_URL, "last_sync": s.get("last_sync"),
            "last_sync_status": s.get("last_sync_status"), "interval_seconds": SYNC_INTERVAL}


@router.get("/report")
async def mirror_report(user: dict = Depends(get_current_user)):
    def _get():
        return requests.get(f"{CLOUD_URL}/cloud/api/report", headers={"X-API-Key": CLOUD_KEY}, timeout=10)
    try:
        resp = await asyncio.to_thread(_get)
        return resp.json()
    except Exception as e:
        raise HTTPException(502, f"Mirror unreachable: {e}")


async def sync_loop():
    while True:
        await asyncio.sleep(SYNC_INTERVAL)
        try:
            await push_to_cloud()
        except Exception:
            pass  # offline-tolerant: POS keeps working, sync resumes later
