"""HK Bar POS — Cloud Reporting Mirror (read-only).
Runs separately from the on-prem POS. Receives pushed aggregates; serves read-only reports.
In production this deploys to a small cloud host; the on-prem server pushes OUT via HTTPS —
no inbound hole into the store network.
"""
import os
from datetime import datetime, timezone
from fastapi import FastAPI, APIRouter, HTTPException, Request
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("CLOUD_DB_NAME", "hkpos_cloud_mirror")
API_KEY = os.environ.get("CLOUD_API_KEY", "hkpos-mirror-key-7f3a9c2e")

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

app = FastAPI(title="HK POS Cloud Mirror")
router = APIRouter(prefix="/cloud/api")


def check_key(request: Request):
    if request.headers.get("X-API-Key") != API_KEY:
        raise HTTPException(401, "bad api key")


@router.get("/health")
async def health():
    return {"ok": True, "service": "hkpos-cloud-mirror"}


@router.post("/ingest")
async def ingest(request: Request):
    check_key(request)
    payload = await request.json()
    payload["received_at"] = datetime.now(timezone.utc).isoformat()
    await db.snapshots.insert_one(dict(payload))
    payload.pop("_id", None)
    await db.latest.replace_one({"venue_id": payload.get("venue_id")}, payload, upsert=True)
    return {"ok": True}


@router.get("/report")
async def report(request: Request):
    check_key(request)
    latest = await db.latest.find_one({}, {"_id": 0})
    history = await db.snapshots.find({}, {"_id": 0, "venue_id": 1, "ts": 1, "sales.total_revenue": 1, "sales.paid_orders": 1}).sort("ts", -1).to_list(50)
    return {"latest": latest, "history": history}


app.include_router(router)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
