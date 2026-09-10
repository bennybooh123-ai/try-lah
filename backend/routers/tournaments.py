"""Darts tournament ledger (5.01) — sign-ups, entry fees, prize pool, audited payouts."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from deps import db, _oid, serialize, sl, MANAGER_ROLES
from auth import make_current_user_dep
from routers.audit import audit_event

get_current_user = make_current_user_dep(lambda: db)
router = APIRouter(prefix="/api", tags=["tournaments"])


def _now():
    return datetime.now(timezone.utc).isoformat()


class TournamentIn(BaseModel):
    name: str
    game: str = "501"
    entry_fee: float = 50.0
    date: str = ""  # YYYY-MM-DD


@router.post("/tournaments")
async def create_tournament(body: TournamentIn, user: dict = Depends(get_current_user)):
    doc = {**body.model_dump(), "status": "open", "created_by": user["name"], "created_at": _now()}
    r = await db.tournaments.insert_one(doc)
    return serialize(await db.tournaments.find_one({"_id": r.inserted_id}))


@router.get("/tournaments")
async def list_tournaments(user: dict = Depends(get_current_user)):
    out = []
    async for t in db.tournaments.find().sort("created_at", -1).limit(50):
        out.append(await _with_ledger(t))
    return out


@router.get("/tournaments/{tid}")
async def get_tournament(tid: str, user: dict = Depends(get_current_user)):
    t = await db.tournaments.find_one({"_id": _oid(tid)})
    if not t:
        raise HTTPException(404, "Not found")
    return await _with_ledger(t)


async def _with_ledger(t: dict) -> dict:
    tid = str(t["_id"])
    players = sl(await db.tournament_players.find({"tournament_id": tid}).to_list(200))
    txs = sl(await db.tournament_txs.find({"tournament_id": tid}).sort("ts", 1).to_list(500))
    collected = round(sum(x["amount"] for x in txs if x["type"] == "entry_fee"), 2)
    paid_out = round(sum(x["amount"] for x in txs if x["type"] == "payout"), 2)
    doc = serialize(t)
    doc["players"] = players
    doc["transactions"] = txs
    doc["ledger"] = {
        "players": len(players),
        "collected": collected,
        "prize_pool": collected,
        "paid_out": paid_out,
        "balance": round(collected - paid_out, 2),
    }
    return doc


@router.post("/tournaments/{tid}/players")
async def add_player(tid: str, body: dict, user: dict = Depends(get_current_user)):
    t = await db.tournaments.find_one({"_id": _oid(tid)})
    if not t:
        raise HTTPException(404, "Not found")
    doc = {"tournament_id": tid, "name": body["name"], "member_id": body.get("member_id"),
           "paid": False, "signed_up_by": user["name"], "ts": _now()}
    r = await db.tournament_players.insert_one(doc)
    return serialize(await db.tournament_players.find_one({"_id": r.inserted_id}))


@router.delete("/tournaments/{tid}/players/{pid}")
async def remove_player(tid: str, pid: str, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    await db.tournament_players.delete_one({"_id": _oid(pid), "tournament_id": tid})
    return {"ok": True}


@router.post("/tournaments/{tid}/collect")
async def collect_entry(tid: str, body: dict, user: dict = Depends(get_current_user)):
    """Collect a player's entry fee: cash / octopus / fps."""
    t = await db.tournaments.find_one({"_id": _oid(tid)})
    if not t:
        raise HTTPException(404, "Not found")
    p = await db.tournament_players.find_one({"_id": _oid(body["player_id"]), "tournament_id": tid})
    if not p:
        raise HTTPException(404, "Player not found")
    if p.get("paid"):
        raise HTTPException(400, "Entry fee already collected")
    amount = round(float(body.get("amount", t["entry_fee"])), 2)
    tx = {"tournament_id": tid, "type": "entry_fee", "amount": amount,
          "method": body.get("method", "cash"), "player": p["name"],
          "recorded_by": user["name"], "ts": _now()}
    r = await db.tournament_txs.insert_one(tx)
    await db.tournament_players.update_one({"_id": p["_id"]}, {"$set": {"paid": True}})
    await audit_event("tournament_entry", {"tournament": t["name"], "player": p["name"],
                      "amount": amount, "method": tx["method"], "tx_id": str(r.inserted_id)}, user["name"])
    return serialize(await db.tournament_txs.find_one({"_id": r.inserted_id}))


@router.post("/tournaments/{tid}/payouts")
async def record_payout(tid: str, body: dict, user: dict = Depends(get_current_user)):
    """Record a prize payout. Guarded: total payouts may not exceed collected pool."""
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    t = await db.tournaments.find_one({"_id": _oid(tid)})
    if not t:
        raise HTTPException(404, "Not found")
    txs = await db.tournament_txs.find({"tournament_id": tid}).to_list(500)
    collected = sum(x["amount"] for x in txs if x["type"] == "entry_fee")
    paid_out = sum(x["amount"] for x in txs if x["type"] == "payout")
    amount = round(float(body["amount"]), 2)
    if paid_out + amount > collected + 0.01:
        raise HTTPException(400, f"Payout exceeds prize pool (balance HK${collected - paid_out:.2f})")
    tx = {"tournament_id": tid, "type": "payout", "amount": amount,
          "place": body.get("place", ""), "recipient": body["recipient"],
          "method": body.get("method", "cash"), "recorded_by": user["name"], "ts": _now()}
    r = await db.tournament_txs.insert_one(tx)
    await audit_event("tournament_payout", {"tournament": t["name"], "recipient": body["recipient"],
                      "amount": amount, "place": body.get("place", ""), "tx_id": str(r.inserted_id)}, user["name"])
    return serialize(await db.tournament_txs.find_one({"_id": r.inserted_id}))


@router.post("/tournaments/{tid}/close")
async def close_tournament(tid: str, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    await db.tournaments.update_one({"_id": _oid(tid)}, {"$set": {"status": "closed", "closed_at": _now()}})
    return await get_tournament(tid, user)
