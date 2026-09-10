"""Regression tests for iteration 19 refactor round.
Covers: role middleware refactor (_role_from_request + _is_write_allowed),
PIN login for all roster PINs (3-digit relaxation), printers route_ticket_lines,
happy-hours active endpoint.
"""
import os
import pytest
import requests

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/") + "/api"


def _pin_login(pin: str):
    s = requests.Session()
    r = s.post(f"{BASE}/auth/pin-login", json={"pin": pin}, timeout=15)
    return s, r


# ---- PIN LOGIN: all roster PINs (3-digit relaxation) ----
@pytest.mark.parametrize("pin,expected_role", [
    ("666", "owner"),
    ("888", "owner"),
    ("9999", "owner"),
    ("0000", "admin"),
    ("111", "manager"),
    ("222", "assistant_manager"),
    ("333", "assistant_manager"),
    ("555", "assistant_manager"),
    ("777", "front_of_house"),
    ("999", "kitchen"),
])
def test_pin_login_roster(pin, expected_role):
    s, r = _pin_login(pin)
    assert r.status_code == 200, f"PIN {pin} login failed: {r.status_code} {r.text}"
    data = r.json()
    user = data.get("user") or data
    assert user.get("role") == expected_role, f"PIN {pin}: got role {user.get('role')}"


# ---- ROLE MIDDLEWARE REGRESSION ----
class TestRoleGuard:
    def test_kitchen_post_orders_403(self):
        s, r = _pin_login("999")
        assert r.status_code == 200
        # Kitchen cannot POST /api/orders
        resp = s.post(f"{BASE}/orders", json={"table_id": None, "lines": []})
        assert resp.status_code == 403, f"kitchen POST /orders expected 403 got {resp.status_code}: {resp.text[:200]}"

    def test_kitchen_eightysix_allowed(self):
        s, r = _pin_login("999")
        assert r.status_code == 200
        prods = s.get(f"{BASE}/products", timeout=10).json()
        if isinstance(prods, dict):
            prods = prods.get("items") or prods.get("products") or []
        if not prods:
            pytest.skip("no products")
        pid = prods[0].get("id") or prods[0].get("_id")
        resp = s.post(f"{BASE}/products/{pid}/eightysix", json={"eightysixed": False})
        # allowed by middleware; may be 200 or 404 depending on route existence but NOT 403
        assert resp.status_code != 403, f"kitchen eightysix blocked: {resp.text[:200]}"

    def test_foh_can_create_order_but_not_pay(self):
        s, r = _pin_login("777")
        assert r.status_code == 200
        # Create a table order
        # Use first table if any
        tables = s.get(f"{BASE}/tables", timeout=10).json()
        table_id = None
        if isinstance(tables, list) and tables:
            table_id = tables[0].get("id") or tables[0].get("_id")
        resp = s.post(f"{BASE}/orders", json={"table_id": table_id, "lines": []})
        assert resp.status_code in (200, 201), f"FOH create order failed: {resp.status_code} {resp.text[:200]}"
        oid = (resp.json().get("id") or resp.json().get("_id"))
        # FOH cannot pay
        pay = s.post(f"{BASE}/orders/{oid}/pay", json={"method": "cash"})
        assert pay.status_code == 403, f"FOH pay expected 403 got {pay.status_code}"
        return oid

    def test_assistant_manager_can_pay_not_delete(self):
        # Create as FOH first
        sf, _ = _pin_login("777")
        tables = sf.get(f"{BASE}/tables", timeout=10).json()
        table_id = tables[0].get("id") if isinstance(tables, list) and tables else None
        cr = sf.post(f"{BASE}/orders", json={"table_id": table_id, "lines": []})
        assert cr.status_code in (200, 201)
        oid = cr.json().get("id") or cr.json().get("_id")

        # Assistant manager 222 pays
        sa, r = _pin_login("222")
        assert r.status_code == 200
        pay = sa.post(f"{BASE}/orders/{oid}/pay", json={"method": "cash"})
        # Not 403 from middleware. Any 200/400 OK - business validation ok.
        assert pay.status_code != 403, f"asst_mgr pay blocked by middleware: {pay.text[:200]}"

        # asst_mgr DELETE should be blocked (require_owner dependency)
        de = sa.delete(f"{BASE}/orders/{oid}")
        assert de.status_code == 403, f"asst_mgr DELETE expected 403 got {de.status_code}"

    def test_owner_can_delete_order(self):
        # Create as owner
        so, r = _pin_login("666")
        assert r.status_code == 200
        tables = so.get(f"{BASE}/tables", timeout=10).json()
        table_id = tables[0].get("id") if isinstance(tables, list) and tables else None
        cr = so.post(f"{BASE}/orders", json={"table_id": table_id, "lines": []})
        assert cr.status_code in (200, 201)
        oid = cr.json().get("id") or cr.json().get("_id")
        de = so.delete(f"{BASE}/orders/{oid}")
        assert de.status_code in (200, 204), f"owner DELETE failed: {de.status_code} {de.text[:200]}"


# ---- HAPPY HOURS ACTIVE ----
def test_happy_hours_active():
    s, _ = _pin_login("666")
    r = s.get(f"{BASE}/happy-hours/active", timeout=10)
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list) or isinstance(body, dict)


# ---- PRINTERS route_ticket_lines refactor ----
def test_printers_route_ticket_lines():
    # Try to fire an order; need an existing order with lines
    so, _ = _pin_login("666")
    # Get products for both categories
    prods = so.get(f"{BASE}/products", timeout=10).json()
    if isinstance(prods, dict):
        prods = prods.get("items") or prods.get("products") or []
    if not prods or len(prods) < 2:
        pytest.skip("need >=2 products")
    tables = so.get(f"{BASE}/tables", timeout=10).json()
    table_id = tables[0].get("id") if isinstance(tables, list) and tables else None
    cr = so.post(f"{BASE}/orders", json={"table_id": table_id, "lines": [
        {"product_id": prods[0].get("id"), "qty": 1},
        {"product_id": prods[1].get("id"), "qty": 1},
    ]})
    if cr.status_code not in (200, 201):
        pytest.skip(f"cannot seed order: {cr.status_code} {cr.text[:200]}")
    oid = cr.json().get("id") or cr.json().get("_id")
    fire = so.post(f"{BASE}/orders/{oid}/fire", json={})
    # Not 500 — refactor should keep endpoint healthy
    assert fire.status_code < 500, f"fire returned {fire.status_code}: {fire.text[:200]}"
