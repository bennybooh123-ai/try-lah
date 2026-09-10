"""Live-sports TV scheduling + pluggable fixtures feed.

- Screen: a named TV. Broadcast: a channel/event booking on a screen for a time window.
- All datetimes are stored UTC and returned with an HKT ISO string for display.
- Fixtures feed adapter defaults to TheSportsDB (free public key). Providers can be
  swapped/added without touching the scheduling code. Sports with thin coverage
  (Gaelic games, full Olympic schedules) return empty -> UI falls back to manual entry.
"""
import os
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

import requests
from fastapi import APIRouter, Depends, HTTPException

from deps import db, _oid, serialize, sl, MANAGER_ROLES
from auth import make_current_user_dep
from models import ScreenIn, BroadcastIn

HK_TZ = ZoneInfo("Asia/Hong_Kong")
get_current_user = make_current_user_dep(lambda: db)
router = APIRouter(prefix="/api", tags=["screens"])


def _now():
    return datetime.now(timezone.utc).isoformat()


def _to_hkt(iso: str | None) -> str | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(HK_TZ).isoformat()
    except Exception:
        return iso


# ---------------- Screens ----------------
@router.get("/screens")
async def list_screens(user: dict = Depends(get_current_user)):
    return sl(await db.screens.find().sort("name", 1).to_list(200))


@router.post("/screens")
async def create_screen(body: ScreenIn, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    doc = body.model_dump()
    doc["created_at"] = _now()
    r = await db.screens.insert_one(doc)
    doc["_id"] = r.inserted_id
    return serialize(doc)


@router.patch("/screens/{sid}")
async def update_screen(sid: str, body: ScreenIn, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    await db.screens.update_one({"_id": _oid(sid)}, {"$set": body.model_dump()})
    return serialize(await db.screens.find_one({"_id": _oid(sid)}))


@router.delete("/screens/{sid}")
async def delete_screen(sid: str, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    await db.screens.delete_one({"_id": _oid(sid)})
    await db.broadcasts.delete_many({"screen_id": sid})
    return {"ok": True}


# ---------------- Broadcasts ----------------
def _overlaps(a_start, a_end, b_start, b_end) -> bool:
    return a_start < b_end and b_start < a_end


async def _conflicts_for(screen_id: str, start: str, end: str, exclude_id: str | None = None) -> list:
    out = []
    for b in await db.broadcasts.find({"screen_id": screen_id}).to_list(500):
        if exclude_id and str(b["_id"]) == exclude_id:
            continue
        if _overlaps(start, end, b.get("start", ""), b.get("end", "")):
            out.append(serialize(b))
    return out


@router.get("/broadcasts")
async def list_broadcasts(user: dict = Depends(get_current_user)):
    screens = {str(s["_id"]): s for s in await db.screens.find().to_list(200)}
    docs = await db.broadcasts.find().sort("start", 1).to_list(1000)
    now = datetime.now(timezone.utc).isoformat()
    out = []
    for d in docs:
        s = serialize(d)
        scr = screens.get(d.get("screen_id"))
        s["screen_name"] = scr["name"] if scr else "?"
        s["start_hkt"] = _to_hkt(d.get("start"))
        s["end_hkt"] = _to_hkt(d.get("end"))
        s["live"] = d.get("start", "") <= now <= d.get("end", "")
        s["upcoming"] = d.get("start", "") > now
        out.append(s)
    return out


@router.get("/broadcasts/board")
async def now_next_board(user: dict = Depends(get_current_user)):
    """Per-screen now-playing + next-up board (HKT)."""
    now = datetime.now(timezone.utc).isoformat()
    screens = await db.screens.find().sort("name", 1).to_list(200)
    board = []
    for s in screens:
        sid = str(s["_id"])
        bs = await db.broadcasts.find({"screen_id": sid}).sort("start", 1).to_list(200)
        now_b = next((b for b in bs if b.get("start", "") <= now <= b.get("end", "")), None)
        next_b = next((b for b in bs if b.get("start", "") > now), None)

        def fmt(b):
            if not b:
                return None
            x = serialize(b)
            x["start_hkt"] = _to_hkt(b.get("start"))
            x["end_hkt"] = _to_hkt(b.get("end"))
            return x

        board.append({"screen": serialize(s), "now": fmt(now_b), "next": fmt(next_b)})
    return board


@router.post("/broadcasts")
async def create_broadcast(body: BroadcastIn, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    conflicts = await _conflicts_for(body.screen_id, body.start, body.end)
    doc = body.model_dump()
    doc["created_at"] = _now()
    doc["created_by"] = user["name"]
    r = await db.broadcasts.insert_one(doc)
    doc["_id"] = r.inserted_id
    out = serialize(doc)
    out["start_hkt"] = _to_hkt(body.start)
    out["end_hkt"] = _to_hkt(body.end)
    out["conflicts"] = conflicts  # warn, never block
    return out


@router.patch("/broadcasts/{bid}")
async def update_broadcast(bid: str, body: BroadcastIn, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    await db.broadcasts.update_one({"_id": _oid(bid)}, {"$set": body.model_dump()})
    out = serialize(await db.broadcasts.find_one({"_id": _oid(bid)}))
    out["conflicts"] = await _conflicts_for(body.screen_id, body.start, body.end, exclude_id=bid)
    return out


@router.delete("/broadcasts/{bid}")
async def delete_broadcast(bid: str, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    await db.broadcasts.delete_one({"_id": _oid(bid)})
    return {"ok": True}


# ---------------- Fixtures feed (pluggable adapter) ----------------
# Curated league map for the sports the bar cares about. Sports with thin/absent
# TheSportsDB coverage are marked manual_only -> UI shows a manual-entry hint.
LEAGUES = [
    {"key": "epl", "name": "English Premier League", "sport": "Football", "league_id": "4328"},
    {"key": "efl_champ", "name": "EFL Championship", "sport": "Football", "league_id": "4329"},
    {"key": "ucl", "name": "UEFA Champions League", "sport": "Football", "league_id": "4480"},
    {"key": "f1", "name": "Formula 1", "sport": "Motorsport", "league_id": "4370"},
    {"key": "motogp", "name": "MotoGP", "sport": "Motorsport", "league_id": "4407"},
    {"key": "rugby_prem", "name": "Rugby Premiership", "sport": "Rugby", "league_id": "4414"},
    {"key": "afl", "name": "AFL", "sport": "Australian Football", "league_id": "4406"},
    {"key": "pga", "name": "PGA Tour (Golf)", "sport": "Golf", "league_id": "4425", "manual_only": True},
    {"key": "cricket_ipl", "name": "Cricket (IPL)", "sport": "Cricket", "league_id": "4460"},
    {"key": "gaelic", "name": "Gaelic Games (GAA)", "sport": "Gaelic Football", "manual_only": True},
    {"key": "olympics", "name": "Olympics (full schedule)", "sport": "Olympics", "manual_only": True},
    {"key": "intl_football", "name": "International Football", "sport": "Football", "league_id": "4429"},
]


def _feed_base() -> str:
    key = os.environ.get("THESPORTSDB_KEY", "3")
    return f"https://www.thesportsdb.com/api/v1/json/{key}"


@router.get("/fixtures/leagues")
async def fixtures_leagues(user: dict = Depends(get_current_user)):
    return LEAGUES


@router.get("/fixtures")
async def fixtures(league_key: str = "epl", user: dict = Depends(get_current_user)):
    """Next fixtures for a league, normalized to HKT. Returns manual_only flag and
    empty list gracefully when the provider has no coverage."""
    league = next((l for l in LEAGUES if l["key"] == league_key), None)
    if not league:
        raise HTTPException(404, "Unknown league")
    if league.get("manual_only") or not league.get("league_id"):
        return {"league": league, "manual_only": True, "fixtures": []}
    url = f"{_feed_base()}/eventsnextleague.php?id={league['league_id']}"
    try:
        resp = requests.get(url, timeout=8)
        data = resp.json() or {}
    except Exception as e:
        return {"league": league, "manual_only": False, "error": str(e), "fixtures": []}
    events = data.get("events") or []
    out = []
    for e in events:
        ts = e.get("strTimestamp")
        start_iso = None
        if ts:
            start_iso = ts if ("+" in ts or ts.endswith("Z")) else ts + "+00:00"
        elif e.get("dateEvent"):
            t = e.get("strTime") or "00:00:00"
            start_iso = f"{e['dateEvent']}T{t}+00:00"
        out.append({
            "fixture_id": e.get("idEvent"),
            "title": e.get("strEvent") or f"{e.get('strHomeTeam','')} vs {e.get('strAwayTeam','')}",
            "sport": e.get("strSport") or league["sport"],
            "league": e.get("strLeague") or league["name"],
            "start_utc": start_iso,
            "start_hkt": _to_hkt(start_iso),
            "venue": e.get("strVenue") or "",
        })
    return {"league": league, "manual_only": False, "fixtures": out}
