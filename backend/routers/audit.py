"""Immutable POS audit chain — append-only log with SHA-256 hash chaining (19.01).

Every sensitive event (payment, void, payout) appends a record whose hash covers
its own payload plus the previous record's hash. Tampering with history breaks
the chain and is detected by /api/audit/verify.
"""
import hashlib
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from deps import db, sl, MANAGER_ROLES
from auth import make_current_user_dep

get_current_user = make_current_user_dep(lambda: db)
router = APIRouter(prefix="/api", tags=["audit"])


async def audit_event(kind: str, payload: dict, actor: str):
    """Append one tamper-evident record. Never throws — audit must not block trade."""
    try:
        last = await db.audit_log.find().sort("seq", -1).limit(1).to_list(1)
        prev_hash = last[0]["hash"] if last else "GENESIS"
        seq = (last[0]["seq"] if last else 0) + 1
        ts = datetime.now(timezone.utc).isoformat()
        body = json.dumps({"seq": seq, "kind": kind, "payload": payload, "actor": actor,
                           "ts": ts, "prev": prev_hash}, sort_keys=True, default=str)
        h = hashlib.sha256(body.encode()).hexdigest()
        await db.audit_log.insert_one({"seq": seq, "kind": kind, "payload": payload,
                                       "actor": actor, "ts": ts, "prev_hash": prev_hash, "hash": h})
    except Exception:
        pass


@router.get("/audit")
async def list_audit(limit: int = 200, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    return sl(await db.audit_log.find().sort("seq", -1).to_list(limit))


@router.get("/audit/verify")
async def verify_audit(user: dict = Depends(get_current_user)):
    """Walk the whole chain and recompute every hash."""
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    entries = await db.audit_log.find().sort("seq", 1).to_list(100000)
    prev = "GENESIS"
    for e in entries:
        if e["prev_hash"] != prev:
            return {"valid": False, "entries": len(entries), "broken_at_seq": e["seq"], "reason": "prev_hash mismatch"}
        body = json.dumps({"seq": e["seq"], "kind": e["kind"], "payload": e["payload"], "actor": e["actor"],
                           "ts": e["ts"], "prev": e["prev_hash"]}, sort_keys=True, default=str)
        if hashlib.sha256(body.encode()).hexdigest() != e["hash"]:
            return {"valid": False, "entries": len(entries), "broken_at_seq": e["seq"], "reason": "hash mismatch"}
        prev = e["hash"]
    return {"valid": True, "entries": len(entries)}
