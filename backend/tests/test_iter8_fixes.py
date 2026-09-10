"""Iter 8 fix verification: (A) 422 error handling, (B) KDS product_id."""
import os
import requests

BASE = os.environ.get("REACT_APP_BACKEND_URL", "https://hk-bar-pos-pro.preview.emergentagent.com").rstrip("/")
API = f"{BASE}/api"

CREDS = {"email": "lunalunamoonshine@gmail.com", "password": "admin123"}


def _login():
    s = requests.Session()
    r = s.post(f"{API}/auth/login", json=CREDS, timeout=15)
    assert r.status_code == 200, f"login failed {r.status_code} {r.text}"
    tok = r.json().get("access_token") or r.json().get("token")
    if tok:
        s.headers["Authorization"] = f"Bearer {tok}"
    return s


def test_login():
    s = _login()
    assert s is not None


def test_pay_422_invalid_method_returns_readable_detail():
    s = _login()
    # Need an order. Create a simple order.
    prods = s.get(f"{API}/products").json()
    assert prods, "no products"
    p = prods[0]
    payload = {
        "order_type": "pick_up",
        "guests": 1,
        "lines": [{"product_id": p["id"], "name": p["name"], "price": p["price"],
                   "qty": 1, "variant": None, "modifiers": [], "course": p.get("course", "main"),
                   "held": False, "notes": ""}],
        "discount_type": "none", "discount_value": 0, "service_charge_pct": 10, "notes": "TEST_iter8",
    }
    r = s.post(f"{API}/orders", json=payload)
    assert r.status_code in (200, 201), r.text
    oid = r.json()["id"]

    # Trigger 422 - fake method
    r = s.post(f"{API}/orders/{oid}/pay", json={"splits": [{"method": "fake_method_xyz", "amount": 100}]})
    assert r.status_code == 422, f"expected 422, got {r.status_code} {r.text}"
    body = r.json()
    assert "detail" in body
    # FastAPI 422 has list of detail with msg field
    d = body["detail"]
    assert isinstance(d, list) and len(d) > 0
    assert "msg" in d[0]
    print("422 msg:", d[0]["msg"])


def test_kds_returns_product_id():
    s = _login()
    # Self-sufficient: create + fire our own order (suite order must not matter)
    prods = {p["id"]: p for p in s.get(f"{API}/products").json()}
    p = next((x for x in prods.values() if not x.get("eightysix")), list(prods.values())[0])
    payload = {
        "order_type": "pick_up", "guests": 1,
        "lines": [{"product_id": p["id"], "name": p["name"], "price": p["price"],
                   "qty": 1, "variant": None, "modifiers": [], "course": p.get("course", "main"),
                   "held": True, "notes": ""}],
        "discount_type": "none", "discount_value": 0, "service_charge_pct": 10, "notes": "TEST_iter8_kds",
    }
    r = s.post(f"{API}/orders", json=payload)
    assert r.status_code in (200, 201), r.text
    oid = r.json()["id"]

    course = p.get("course", "main")
    fr = s.post(f"{API}/orders/{oid}/fire", params={"course": course})
    assert fr.status_code == 200, fr.text

    kds = s.get(f"{API}/kds").json()
    assert isinstance(kds, list)
    mine = [t for t in kds if t.get("order_id") == oid]
    assert mine, f"no kds ticket for order {oid}; kds={kds[:3]}"
    t = mine[0]
    assert "product_id" in t, f"kds ticket missing product_id: {t}"
    assert t["product_id"] == p["id"], f"product_id mismatch {t['product_id']} != {p['id']}"
    # All tickets expose product_id, and at least one matches a real product
    for tk in kds:
        assert "product_id" in tk, f"missing product_id: {tk}"
    assert any(tk["product_id"] in prods for tk in kds), "no kds ticket product_id matched a product"


def test_kds_86_flow_hides_from_public_menu():
    s = _login()
    # Self-sufficient: create + fire our own ticket to get a product_id
    prods = {p["id"]: p for p in s.get(f"{API}/products").json()}
    p = next((x for x in prods.values() if not x.get("eightysix")), list(prods.values())[0])
    r = s.post(f"{API}/orders", json={
        "order_type": "pick_up", "guests": 1,
        "lines": [{"product_id": p["id"], "name": p["name"], "price": p["price"],
                   "qty": 1, "variant": None, "modifiers": [], "course": p.get("course", "main"),
                   "held": True, "notes": ""}],
        "discount_type": "none", "discount_value": 0, "service_charge_pct": 10, "notes": "TEST_iter8_86",
    })
    assert r.status_code in (200, 201), r.text
    oid = r.json()["id"]
    fr = s.post(f"{API}/orders/{oid}/fire", params={"course": p.get("course", "main")})
    assert fr.status_code == 200, fr.text
    kds = s.get(f"{API}/kds").json()
    mine = [t for t in kds if t.get("order_id") == oid]
    assert mine, f"no kds ticket for order {oid}"
    pid = mine[0]["product_id"]
    assert pid, "kds ticket has no product_id"

    # 86 via product_id (as frontend now does)
    r86 = s.post(f"{API}/products/{pid}/eightysix", params={"on": True})
    assert r86.status_code == 200, r86.text

    # Verify product.eightysix true
    p2 = next(x for x in s.get(f"{API}/products").json() if x["id"] == pid)
    assert p2.get("eightysix") == True

    # Verify /api/public/menu/{table_id} excludes it
    tables = s.get(f"{API}/tables").json()
    table_id = tables[0]["id"] if tables else None
    assert table_id, "no tables to query public menu"
    pm = requests.get(f"{API}/public/menu/{table_id}", timeout=15)
    assert pm.status_code == 200, pm.text
    menu = pm.json()
    all_pids = []
    # menu shape may be {categories:[{products:[...]}]} or flat list
    if isinstance(menu, dict):
        for cat in menu.get("categories", []) or []:
            for pr in cat.get("products", []) or []:
                all_pids.append(pr.get("id"))
        for pr in menu.get("products", []) or []:
            all_pids.append(pr.get("id"))
    elif isinstance(menu, list):
        for pr in menu:
            all_pids.append(pr.get("id"))
    assert pid not in all_pids, f"86'd product still visible in public menu; pid={pid}"

    # Verify /api/kds still works after
    k2 = s.get(f"{API}/kds")
    assert k2.status_code == 200

    # cleanup: un-86
    s.post(f"{API}/products/{pid}/eightysix", params={"on": False})
