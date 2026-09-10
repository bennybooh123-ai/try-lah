"""Physical printer routing — server-side ESC/POS to LAN IP printers.

Routing rules: product kind 'drink' -> bar printers, 'food' -> kitchen printers,
bills/receipts -> receipt printers. A printer with role 'mixed' receives all roles.

SIMULATION MODE: jobs are logged and marked printed/failed based on the
printer's `online` flag. To go live on real hardware, install python-escpos and
replace `_dispatch` with `Network(p['ip'], p['port']).text(job_content)`.
Printers must have static LAN IPs or routing breaks intermittently.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from deps import db, _oid, serialize, sl, MANAGER_ROLES
from auth import make_current_user_dep

get_current_user = make_current_user_dep(lambda: db)
router = APIRouter(prefix="/api", tags=["printers"])

KIND_TO_ROLE = {"drink": "bar", "food": "kitchen"}


class PrinterIn(BaseModel):
    name: str
    ip: str
    port: int = 9100
    role: str = "receipt"  # bar | kitchen | receipt | mixed
    online: bool = True
    active: bool = True


def _now():
    return datetime.now(timezone.utc).isoformat()


async def _alert(kind: str, message: str, ref: str = ""):
    await db.alerts.insert_one({"kind": kind, "message": message, "ref": ref, "ts": _now(), "ack": False})


async def _dispatch(printer: dict, job: dict) -> str:
    """SIMULATION — real ESC/POS bytes go over TCP :9100 here."""
    return "printed" if printer.get("online") and printer.get("active", True) else "failed"


async def _create_job(printer: dict, role: str, job_type: str, order: dict, table_name: str, lines: list, user: dict):
    text = [f"*** {printer['name']} ***", f"{job_type.upper()}  Table: {table_name}",
            f"By: {user.get('name')}  {_now()}"]
    for l in lines:
        v = f" ({l['variant']})" if l.get("variant") else ""
        text.append(f"{l['qty']}x {l['name']}{v}")
        for m in l.get("modifiers") or []:
            text.append(f"   + {m if isinstance(m, str) else m.get('name')}")
        if l.get("notes"):
            text.append(f"   !! {l['notes']}")
    job = {
        "printer_id": str(printer["_id"]), "printer_name": printer["name"], "role": role,
        "job_type": job_type, "order_id": str(order["_id"]), "table": table_name,
        "content": "\n".join(text), "attempts": 1, "ts": _now(), "status": "queued",
    }
    job["status"] = await _dispatch(printer, job)
    r = await db.print_jobs.insert_one(job)
    if job["status"] == "failed":
        await _alert("print", f"Print FAILED on {printer['name']} ({printer.get('ip')}) — {job_type} for {table_name}", str(r.inserted_id))
    return job["status"]


async def _target_printers(role: str) -> list:
    return await db.printers.find({"role": {"$in": [role, "mixed"]}, "active": True}).to_list(20)


async def _group_lines_by_role(lines: list) -> dict:
    """Bucket lines by target printer role using product kind (drink->bar, food->kitchen)."""
    prods = {str(p["_id"]): p for p in await db.products.find().to_list(2000)}
    by_role: dict = {}
    for l in lines:
        p = prods.get(l.get("product_id") or "")
        kind = (p or {}).get("kind") or ("drink" if l.get("course") == "drink" else "food")
        by_role.setdefault(KIND_TO_ROLE.get(kind, "kitchen"), []).append(l)
    return by_role


async def route_ticket_lines(order: dict, lines: list, user: dict):
    """Route fired lines to bar/kitchen printers by product kind."""
    if not lines:
        return
    table_name = "TAKEAWAY"
    if order.get("table_id"):
        t = await db.tables.find_one({"_id": _oid(order["table_id"])})
        table_name = t["name"] if t else "TAKEAWAY"
    for role, role_lines in (await _group_lines_by_role(lines)).items():
        printers = await _target_printers(role)
        if not printers:
            await _alert("print", f"No active printer for role '{role}' — ticket for {table_name} NOT printed", str(order["_id"]))
            continue
        for pr in printers:
            await _create_job(pr, role, "ticket", order, table_name, role_lines, user)


async def print_receipt(order: dict, payment: dict, user: dict):
    table_name = "TAKEAWAY"
    if order.get("table_id"):
        t = await db.tables.find_one({"_id": _oid(order["table_id"])})
        table_name = t["name"] if t else "TAKEAWAY"
    lines = list(order.get("lines", []))
    printers = await _target_printers("receipt")
    if not printers:
        await _alert("print", f"No receipt printer — bill for {table_name} NOT printed", str(order["_id"]))
        return
    for pr in printers:
        job_lines = lines + [{
            "qty": "", "name": f"TOTAL HK${order.get('total', 0):.2f} · {payment.get('method', '').upper()}",
            "variant": None, "modifiers": [], "notes": "",
        }]
        await _create_job(pr, "receipt", "receipt", order, table_name, job_lines, user)


# ---------- endpoints ----------
@router.get("/printers")
async def list_printers(user: dict = Depends(get_current_user)):
    return sl(await db.printers.find().to_list(50))


@router.post("/printers")
async def create_printer(body: PrinterIn, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    doc = body.model_dump()
    doc["created_at"] = _now()
    r = await db.printers.insert_one(doc)
    return serialize(await db.printers.find_one({"_id": r.inserted_id}))


@router.patch("/printers/{pid}")
async def update_printer(pid: str, body: dict, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    upd = {k: v for k, v in body.items() if k in ("name", "ip", "port", "role", "online", "active")}
    await db.printers.update_one({"_id": _oid(pid)}, {"$set": upd})
    return serialize(await db.printers.find_one({"_id": _oid(pid)}))


@router.delete("/printers/{pid}")
async def delete_printer(pid: str, user: dict = Depends(get_current_user)):
    if user["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "Manager only")
    await db.printers.delete_one({"_id": _oid(pid)})
    return {"ok": True}


@router.get("/print-jobs")
async def list_jobs(status: str = None, limit: int = 100, user: dict = Depends(get_current_user)):
    q = {"status": status} if status else {}
    return sl(await db.print_jobs.find(q).sort("ts", -1).to_list(limit))


@router.post("/print-jobs/{jid}/retry")
async def retry_job(jid: str, user: dict = Depends(get_current_user)):
    job = await db.print_jobs.find_one({"_id": _oid(jid)})
    if not job:
        raise HTTPException(404, "Not found")
    printer = await db.printers.find_one({"_id": _oid(job["printer_id"])})
    status = "printed" if printer and printer.get("online") and printer.get("active", True) else "failed"
    await db.print_jobs.update_one({"_id": job["_id"]},
        {"$set": {"status": status, "ts": _now()}, "$inc": {"attempts": 1}})
    if status == "failed":
        await _alert("print", f"Retry FAILED on {job['printer_name']} — {job['job_type']} for {job['table']}", jid)
    return {"status": status}


@router.get("/alerts")
async def list_alerts(user: dict = Depends(get_current_user)):
    return sl(await db.alerts.find().sort("ts", -1).to_list(100))


@router.post("/alerts/{aid}/ack")
async def ack_alert(aid: str, user: dict = Depends(get_current_user)):
    await db.alerts.update_one({"_id": _oid(aid)}, {"$set": {"ack": True}})
    return {"ok": True}
