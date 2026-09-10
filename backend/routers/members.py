"""Members-as-live-tab CRM: loyalty points, spendable credit, redemption engine.

Money-adjacent changes (credit, points, discounts, coupons) are admin/manager only
and PIN-gated, and every one lands on the immutable audit chain. Staff may edit only
whitelisted profile fields via PATCH /members/{id}.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from deps import db, _oid, serialize, sl, MANAGER_ROLES
from auth import make_current_user_dep
from models import MemberPatchIn, MemberAdjustIn, RedeemIn, GrantRewardIn, LoyaltyConfigIn
from routers.audit import audit_event

get_current_user = make_current_user_dep(lambda: db)
router = APIRouter(prefix="/api", tags=["members"])

DEFAULT_LOYALTY = {
    "points_per_hkd": 0.1,
    "tier_multipliers": {"Regular": 1.0, "Silver": 1.25, "Gold": 1.5, "VIP": 2.0},
    "coupon_points_cost": 100,
    "coupon_value": 10.0,
}


def _now():
    return datetime.now(timezone.utc).isoformat()


async def get_loyalty_config() -> dict:
    doc = await db.settings.find_one({"key": "loyalty"})
    if not doc:
        return dict(DEFAULT_LOYALTY)
    cfg = dict(DEFAULT_LOYALTY)
    cfg.update({k: doc[k] for k in DEFAULT_LOYALTY if k in doc})
    return cfg


async def _resolve_manager(user: dict, pin: str | None) -> dict:
    """Return an authorised manager actor or raise 403. Managers act as themselves."""
    if user.get("role") in MANAGER_ROLES:
        return {"id": user["id"], "name": user["name"], "role": user["role"]}
    mgr = await db.users.find_one({"pin": pin or "", "role": {"$in": list(MANAGER_ROLES)}, "active": True})
    if not mgr:
        raise HTTPException(403, "Manager PIN required")
    return {"id": str(mgr["_id"]), "name": mgr["name"], "role": mgr["role"]}


# ---------------- Loyalty config ----------------
@router.get("/loyalty/config")
async def loyalty_config(user: dict = Depends(get_current_user)):
    return await get_loyalty_config()


@router.put("/loyalty/config")
async def set_loyalty_config(body: LoyaltyConfigIn, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    await db.settings.update_one({"key": "loyalty"}, {"$set": {"key": "loyalty", **body.model_dump()}}, upsert=True)
    await audit_event("loyalty_config", body.model_dump(), user["name"])
    return await get_loyalty_config()


# ---------------- Points & credit statement ----------------
@router.get("/members/{mid}/statement")
async def member_statement(mid: str, user: dict = Depends(get_current_user)):
    m = await db.members.find_one({"_id": _oid(mid)})
    if not m:
        raise HTTPException(404, "Not found")
    cfg = await get_loyalty_config()
    mult = float((cfg.get("tier_multipliers") or {}).get(m.get("tier", "Regular"), 1.0))
    ppd = float(cfg.get("points_per_hkd", 0.1))
    paid = await db.orders.find({"member_id": mid, "status": "paid"}).sort("closed_at", -1).to_list(50)
    earn_rows = [{
        "order_id": str(o["_id"]), "date": o.get("closed_at"),
        "total": o.get("total", 0),
        "points_earned": int(o.get("total", 0) * ppd * mult),
    } for o in paid]
    return {
        "member": {
            "id": mid, "name": m.get("name"), "phone": m.get("phone"), "email": m.get("email"),
            "tier": m.get("tier"), "join_date": m.get("join_date"), "last_visit": m.get("last_visit"),
        },
        "points": m.get("points", 0),
        "credit_balance": round(m.get("credit_balance", 0.0), 2),
        "lifetime_spend": round(m.get("lifetime_spend", 0.0), 2),
        "visits": m.get("visits", 0),
        "tier_multiplier": mult,
        "points_per_hkd": ppd,
        "earning_history": earn_rows,
        "rewards": m.get("rewards") or [],
        "generated_at": _now(),
    }


# ---------------- Whitelisted staff edit ----------------
@router.patch("/members/{mid}")
async def patch_member(mid: str, body: MemberPatchIn, user: dict = Depends(get_current_user)):
    upd = {k: v for k, v in body.model_dump().items() if v is not None}
    if not upd:
        raise HTTPException(400, "Nothing to update")
    await db.members.update_one({"_id": _oid(mid)}, {"$set": upd})
    return serialize(await db.members.find_one({"_id": _oid(mid)}))


# ---------------- Live tab ----------------
@router.get("/members/{mid}/tab")
async def member_tab(mid: str, user: dict = Depends(get_current_user)):
    m = await db.members.find_one({"_id": _oid(mid)})
    if not m:
        raise HTTPException(404, "Not found")
    open_orders = await db.orders.find({"member_id": mid, "status": {"$in": ["open", "pending_confirm"]}}).to_list(50)
    open_balance = round(sum(o.get("total", 0) for o in open_orders), 2)
    return {
        "member_id": mid,
        "name": m.get("name"),
        "points": m.get("points", 0),
        "credit_balance": round(m.get("credit_balance", 0.0), 2),
        "member_discount_pct": m.get("member_discount_pct", 0.0),
        "tier": m.get("tier"),
        "open_orders": len(open_orders),
        "open_balance": open_balance,
        "rewards": [r for r in (m.get("rewards") or []) if not r.get("redeemed")],
    }


# ---------------- Manual money adjustment (manager, PIN, audited) ----------------
@router.post("/members/{mid}/adjust")
async def adjust_member(mid: str, body: MemberAdjustIn, user: dict = Depends(get_current_user)):
    actor = await _resolve_manager(user, body.manager_pin)
    m = await db.members.find_one({"_id": _oid(mid)})
    if not m:
        raise HTTPException(404, "Not found")
    if body.field == "member_discount_pct":
        newv = max(0.0, min(100.0, body.set_value if body.set_value is not None else body.delta))
        await db.members.update_one({"_id": _oid(mid)}, {"$set": {"member_discount_pct": newv}})
    elif body.field == "points":
        newv = max(0, int(m.get("points", 0) + body.delta))
        await db.members.update_one({"_id": _oid(mid)}, {"$set": {"points": newv}})
    else:  # credit
        newv = round(max(0.0, m.get("credit_balance", 0.0) + body.delta), 2)
        await db.members.update_one({"_id": _oid(mid)}, {"$set": {"credit_balance": newv}})
    await audit_event("member_adjust", {
        "member_id": mid, "member": m.get("name"), "field": body.field,
        "delta": body.delta, "set_value": body.set_value, "reason": body.reason,
        "approved_by": actor["name"],
    }, user["name"])
    return serialize(await db.members.find_one({"_id": _oid(mid)}))


# ---------------- Redemption: points -> spendable credit coupon ----------------
@router.post("/members/{mid}/redeem")
async def redeem_points(mid: str, body: RedeemIn, user: dict = Depends(get_current_user)):
    actor = await _resolve_manager(user, body.manager_pin)
    m = await db.members.find_one({"_id": _oid(mid)})
    if not m:
        raise HTTPException(404, "Not found")
    cfg = await get_loyalty_config()
    cost = int(cfg["coupon_points_cost"])
    unit_value = float(cfg["coupon_value"])
    if cost <= 0:
        raise HTTPException(400, "Loyalty coupon cost misconfigured")
    if body.points < cost or body.points % cost != 0:
        raise HTTPException(400, f"Redeem in multiples of {cost} points")
    if m.get("points", 0) < body.points:
        raise HTTPException(400, "Insufficient points")
    blocks = body.points // cost
    credit_added = round(blocks * unit_value, 2)
    reward = {
        "type": "cash_coupon", "value": credit_added, "code": f"PTS-{int(datetime.now(timezone.utc).timestamp())}",
        "issued_at": _now(), "issued_by": actor["name"], "redeemed": True, "note": f"{body.points} pts",
    }
    await db.members.update_one({"_id": _oid(mid)}, {
        "$inc": {"points": -body.points, "credit_balance": credit_added},
        "$push": {"rewards": reward},
    })
    await audit_event("member_redeem", {
        "member_id": mid, "member": m.get("name"), "points_spent": body.points,
        "credit_added": credit_added, "approved_by": actor["name"],
    }, user["name"])
    return serialize(await db.members.find_one({"_id": _oid(mid)}))


# ---------------- Grant a % / cash / BXGY reward (manager, audited) ----------------
@router.post("/members/{mid}/rewards")
async def grant_reward(mid: str, body: GrantRewardIn, user: dict = Depends(get_current_user)):
    actor = await _resolve_manager(user, body.manager_pin)
    m = await db.members.find_one({"_id": _oid(mid)})
    if not m:
        raise HTTPException(404, "Not found")
    reward = {
        "type": body.kind, "value": body.value, "buy_qty": body.buy_qty, "get_qty": body.get_qty,
        "label": body.label or {"percent": f"{body.value}% off", "cash": f"HK${body.value} off",
                                "bxgy": f"Buy {body.buy_qty} get {body.get_qty} free"}.get(body.kind, "reward"),
        "code": f"RW-{int(datetime.now(timezone.utc).timestamp())}",
        "issued_at": _now(), "issued_by": actor["name"], "redeemed": False,
    }
    await db.members.update_one({"_id": _oid(mid)}, {"$push": {"rewards": reward}})
    await audit_event("member_reward_grant", {"member_id": mid, "member": m.get("name"), **reward,
                      "approved_by": actor["name"]}, user["name"])
    return serialize(await db.members.find_one({"_id": _oid(mid)}))
