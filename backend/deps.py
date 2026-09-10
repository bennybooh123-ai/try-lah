"""Shared FastAPI dependencies (splits server.py into routers)."""
import os
from datetime import datetime
from zoneinfo import ZoneInfo
from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient

HK_TZ = ZoneInfo("Asia/Hong_Kong")

_client = AsyncIOMotorClient(os.environ["MONGO_URL"])
db = _client[os.environ["DB_NAME"]]


def _oid(x: str) -> ObjectId:
    try:
        return ObjectId(x)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid id")


def serialize(doc: dict) -> dict:
    if not doc:
        return doc
    doc = dict(doc)
    if "_id" in doc:
        doc["id"] = str(doc.pop("_id"))
    return doc


def sl(docs: list) -> list:
    return [serialize(d) for d in docs]


def now_iso() -> str:
    return datetime.now(HK_TZ).isoformat()


# ---- Role hierarchy: owner (godmode) > admin = manager = assistant_manager > cashier / front_of_house / kitchen ----
MANAGER_ROLES = ("owner", "admin", "manager", "assistant_manager")
KITCHEN_ROLES = MANAGER_ROLES + ("kitchen",)


def require_manager(user: dict):
    if user.get("role") not in MANAGER_ROLES:
        raise HTTPException(403, "Manager role required")


def require_owner(user: dict):
    if user.get("role") != "owner":
        raise HTTPException(403, "Owner only")
