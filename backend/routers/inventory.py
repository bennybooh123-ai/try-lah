"""Ingredient-level inventory — extends the keg-tracking pattern.

Recipes (BOM) live on product docs:
  product["recipe"]           -> [{ingredient_id, qty}] base pour
  product["variant_recipes"]  -> {variant_name: [{ingredient_id, qty}]}
  product["modifiers"][i]["recipe"] -> extra deduction when modifier picked
Deduction happens on PAID sale only. Restock + wastage logging is mandatory
operational discipline — without it counts drift and alerts become untrusted.
Negative-stock guard: stock never goes below zero; shortfall raises an alert.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from deps import db, _oid, serialize, sl, MANAGER_ROLES
from auth import make_current_user_dep

get_current_user = make_current_user_dep(lambda: db)
router = APIRouter(prefix="/api", tags=["inventory"])


def _now():
    return datetime.now(timezone.utc).isoformat()


async def _inv_alert(message: str, ref: str = ""):
    await db.alerts.insert_one({"kind": "stock", "message": message, "ref": ref, "ts": _now(), "ack": False})


def _line_recipes(p: dict, l: dict) -> list:
    recipes = []
    vrec = (p.get("variant_recipes") or {}).get(l.get("variant") or "")
    recipes += vrec if vrec else (p.get("recipe") or [])
    picked = {m if isinstance(m, str) else m.get("name") for m in (l.get("modifiers") or [])}
    for m in p.get("modifiers") or []:
        if isinstance(m, dict) and m.get("name") in picked and m.get("recipe"):
            recipes += m["recipe"]
    return recipes


async def _apply_movement(recipes: list, qty: float, mtype: str, ref: str, by: str, line_name: str = ""):
    for r in recipes:
        need = round(r["qty"] * qty, 3)
        ing = await db.ingredients.find_one({"_id": _oid(r["ingredient_id"])})
        if not ing:
            continue
        take = min(ing["qty"], need)  # negative-stock guard
        new_qty = round(ing["qty"] - take, 3)
        await db.ingredients.update_one({"_id": ing["_id"]}, {"$set": {"qty": new_qty}})
        await db.inv_movements.insert_one({
            "ingredient_id": str(ing["_id"]), "name": ing["name"], "delta": -take,
            "type": mtype, "ref": ref, "by": by, "ts": _now()})
        if take < need:
            await _inv_alert(f"Stock-out: {ing['name']} short by {round(need - take, 3)}{ing['unit']} ({line_name or mtype})", str(ing["_id"]))
        if new_qty <= ing.get("par_level", 0):
            await _inv_alert(f"Low stock: {ing['name']} at {new_qty}{ing['unit']} (par {ing.get('par_level', 0)})", str(ing["_id"]))


async def deduct_ingredients_for_order(order: dict, user_name: str = "system"):
    """Deduct recipe ingredients for every line of a paid order."""
    prods = {str(p["_id"]): p for p in await db.products.find().to_list(2000)}
    for l in order.get("lines", []):
        p = prods.get(l.get("product_id") or "")
        if not p:
            continue
        await _apply_movement(_line_recipes(p, l), l.get("qty", 1), "sale", str(order["_id"]), user_name, l.get("name", ""))


async def waste_line_ingredients(line: dict, by: str, reason: str):
    """A fired-then-voided line consumed real stock: log it as wastage."""
    p = await db.products.find_one({"_id": _oid(line["product_id"])}) if line.get("product_id") else None
    if not p:
        return
    await _apply_movement(_line_recipes(p, line), line.get("qty", 1), "wastage", f"void: {reason}", by, line.get("name", ""))


# ---------- endpoints ----------
class IngredientIn(BaseModel):
    name: str
    unit: str = "ml"
    qty: float = 0.0
    par_level: float = 0.0
    cost_per_unit: float = 0.0


@router.get("/ingredients")
async def list_ingredients(user: dict = Depends(get_current_user)):
    rows = sl(await db.ingredients.find().to_list(500))
    for r in rows:
        r["low"] = r["qty"] <= r.get("par_level", 0)
    return rows


@router.post("/ingredients")
async def create_ingredient(body: IngredientIn, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    doc = body.model_dump()
    doc["created_at"] = _now()
    r = await db.ingredients.insert_one(doc)
    return serialize(await db.ingredients.find_one({"_id": r.inserted_id}))


@router.patch("/ingredients/{iid}")
async def update_ingredient(iid: str, body: dict, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    upd = {k: v for k, v in body.items() if k in ("name", "unit", "par_level", "cost_per_unit")}
    await db.ingredients.update_one({"_id": _oid(iid)}, {"$set": upd})
    return serialize(await db.ingredients.find_one({"_id": _oid(iid)}))


@router.delete("/ingredients/{iid}")
async def delete_ingredient(iid: str, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    await db.ingredients.delete_one({"_id": _oid(iid)})
    return {"ok": True}


@router.post("/ingredients/{iid}/restock")
async def restock(iid: str, body: dict, user: dict = Depends(get_current_user)):
    qty = float(body.get("qty", 0))
    if qty <= 0:
        raise HTTPException(400, "qty must be > 0")
    await db.ingredients.update_one({"_id": _oid(iid)}, {"$inc": {"qty": qty}})
    ing = await db.ingredients.find_one({"_id": _oid(iid)})
    await db.inv_movements.insert_one({"ingredient_id": iid, "name": ing["name"], "delta": qty,
        "type": "restock", "ref": body.get("note", ""), "by": user["name"], "ts": _now()})
    return serialize(ing)


@router.post("/ingredients/{iid}/wastage")
async def wastage(iid: str, body: dict, user: dict = Depends(get_current_user)):
    qty = float(body.get("qty", 0))
    if qty <= 0:
        raise HTTPException(400, "qty must be > 0")
    ing = await db.ingredients.find_one({"_id": _oid(iid)})
    take = min(ing["qty"], qty)
    await db.ingredients.update_one({"_id": ing["_id"]}, {"$set": {"qty": round(ing["qty"] - take, 3)}})
    await db.inv_movements.insert_one({"ingredient_id": iid, "name": ing["name"], "delta": -take,
        "type": "wastage", "ref": body.get("reason", ""), "by": user["name"], "ts": _now()})
    return serialize(await db.ingredients.find_one({"_id": ing["_id"]}))


@router.get("/inventory/movements")
async def movements(limit: int = 100, user: dict = Depends(get_current_user)):
    return sl(await db.inv_movements.find().sort("ts", -1).to_list(limit))


@router.get("/inventory/usage")
async def usage(user: dict = Depends(get_current_user)):
    rows = await db.inv_movements.find({"type": {"$in": ["sale", "wastage"]}}).to_list(10000)
    agg: dict = {}
    for r in rows:
        a = agg.setdefault(r["ingredient_id"], {"ingredient_id": r["ingredient_id"], "name": r["name"], "sold": 0.0, "wasted": 0.0})
        if r["type"] == "sale":
            a["sold"] = round(a["sold"] - r["delta"], 3)
        else:
            a["wasted"] = round(a["wasted"] - r["delta"], 3)
    return list(agg.values())


@router.get("/inventory/purchase-suggestions")
async def purchase_suggestions(user: dict = Depends(get_current_user)):
    """Suggested restock = par x 2 - on hand. Saves the manager mental math."""
    out = []
    async for i in db.ingredients.find():
        suggested = round(max(0.0, i.get("par_level", 0) * 2 - i["qty"]), 3)
        if suggested > 0:
            out.append({
                "ingredient_id": str(i["_id"]), "name": i["name"], "unit": i["unit"],
                "on_hand": i["qty"], "par_level": i.get("par_level", 0),
                "suggested_qty": suggested,
                "est_cost": round(suggested * i.get("cost_per_unit", 0), 2),
            })
    out.sort(key=lambda x: -x["est_cost"])
    return out


@router.post("/inventory/spot-count")
async def spot_count(body: dict, user: dict = Depends(get_current_user)):
    """Weekly spot count: counted vs system qty -> variance + count_adjust movements."""
    variances = []
    for c in body.get("counts", []):
        ing = await db.ingredients.find_one({"_id": _oid(c["ingredient_id"])})
        if not ing:
            continue
        counted = float(c["counted"])
        var = round(counted - ing["qty"], 3)
        if abs(var) > 1e-9:
            await db.ingredients.update_one({"_id": ing["_id"]}, {"$set": {"qty": counted}})
            await db.inv_movements.insert_one({
                "ingredient_id": str(ing["_id"]), "name": ing["name"], "delta": var,
                "type": "count_adjust", "ref": body.get("note", "spot count"), "by": user["name"], "ts": _now()})
        variances.append({"ingredient_id": str(ing["_id"]), "name": ing["name"], "unit": ing["unit"],
                          "expected": ing["qty"], "counted": counted, "variance": var})
    doc = {"by": user["name"], "ts": _now(), "note": body.get("note", ""), "variances": variances,
           "total_variance_items": sum(1 for v in variances if abs(v["variance"]) > 1e-9)}
    r = await db.spot_counts.insert_one(doc)
    return serialize(await db.spot_counts.find_one({"_id": r.inserted_id}))


@router.get("/inventory/spot-counts")
async def spot_count_history(limit: int = 10, user: dict = Depends(get_current_user)):
    return sl(await db.spot_counts.find().sort("ts", -1).to_list(limit))
