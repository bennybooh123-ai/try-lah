"""Iter 18 — brownfield hardening: printers, inventory, card_terminal, cloud mirror, HR."""
import os
import time
import pytest
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
load_dotenv(Path("/app/frontend/.env"))

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL missing"
CLOUD_URL = os.environ.get("CLOUD_MIRROR_URL", "http://localhost:8002").rstrip("/")
CLOUD_KEY = os.environ.get("CLOUD_API_KEY", "")
assert CLOUD_KEY, "CLOUD_API_KEY missing from backend/.env"
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
ADMIN_PIN = os.environ.get("ADMIN_PIN", "")
assert ADMIN_EMAIL and ADMIN_PASSWORD and ADMIN_PIN, "ADMIN_* creds missing from backend/.env"


# --- Fixtures ---
@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, r.text
    tok = r.json()["token"]
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


@pytest.fixture(scope="module")
def products(api):
    return api.get(f"{BASE_URL}/api/products").json()


@pytest.fixture(scope="module")
def tables(api):
    return api.get(f"{BASE_URL}/api/tables").json()


def _find(products, name):
    p = next((x for x in products if x["name"] == name), None)
    assert p, f"seed product {name} missing"
    return p


def _free_table(api):
    ts = api.get(f"{BASE_URL}/api/tables").json()
    t = next((x for x in ts if x.get("status") != "occupied"), None)
    assert t, "no free table"
    return t


def _restock(api, names, qty):
    """Idempotency helper: top up ingredients so repeated test runs never hit
    the negative-stock guard (which would clamp deductions to zero)."""
    ings = {i["name"]: i for i in api.get(f"{BASE_URL}/api/ingredients").json()}
    for n in names:
        r = api.post(f"{BASE_URL}/api/ingredients/{ings[n]['id']}/restock",
                     json={"qty": qty, "note": "test top-up"})
        assert r.status_code == 200, r.text


# --- Auth: PIN login auto-clock-in ---
class TestAuthPinShift:
    def test_email_login(self):
        r = requests.post(f"{BASE_URL}/api/auth/login",
                          json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        assert r.status_code == 200
        assert r.json()["user"]["role"] == "owner"

    def test_pin_login_auto_shift(self):
        # Use assistant-manager PIN 222 to test auto-clock-in without polluting admin
        r = requests.post(f"{BASE_URL}/api/auth/pin-login", json={"pin": "222"})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["user"]["role"] == "assistant_manager"
        tok = data["token"]
        s = requests.Session()
        s.headers.update({"Authorization": f"Bearer {tok}"})
        cur = s.get(f"{BASE_URL}/api/shifts/current")
        assert cur.status_code == 200
        body = cur.json()
        assert body and body.get("shift"), f"expected open shift after PIN login: {body}"


# --- Printer routing ---
class TestPrinterRouting:
    def test_fire_routes_bar_and_kitchen(self, api, products, tables):
        # Ensure Bar Printer #1 online
        prs = api.get(f"{BASE_URL}/api/printers").json()
        bar = next(p for p in prs if p["name"] == "Bar Printer #1")
        kitchen = next(p for p in prs if p["name"] == "Kitchen Printer #1")
        if not bar.get("online"):
            api.patch(f"{BASE_URL}/api/printers/{bar['id']}", json={"online": True})
        drink = _find(products, "Neon Negroni")
        food = _find(products, "Truffle Fries")
        table = _free_table(api)
        payload = {
            "order_type": "dine_in", "table_id": table["id"], "guests": 2,
            "service_charge_pct": 10.0,
            "lines": [
                {"product_id": drink["id"], "name": drink["name"], "price": drink["price"], "qty": 1, "course": "drink", "seat": 1, "held": True, "kind": "drink"},
                {"product_id": food["id"], "name": food["name"], "price": food["price"], "qty": 1, "course": "food", "seat": 1, "held": True, "kind": "food"},
            ],
        }
        cr = api.post(f"{BASE_URL}/api/orders", json=payload)
        assert cr.status_code == 200, cr.text
        oid = cr.json()["id"]
        try:
            fr = api.post(f"{BASE_URL}/api/orders/{oid}/fire")
            assert fr.status_code == 200, fr.text
            jobs = api.get(f"{BASE_URL}/api/print-jobs").json()
            recent = [j for j in jobs if j["order_id"] == oid]
            assert any(j["printer_name"] == "Bar Printer #1" and j["role"] == "bar" and j["status"] == "printed" for j in recent), \
                f"missing bar printed job: {recent}"
            assert any(j["printer_name"] == "Kitchen Printer #1" and j["role"] == "kitchen" and j["status"] == "printed" for j in recent), \
                f"missing kitchen printed job: {recent}"
        finally:
            api.delete(f"{BASE_URL}/api/orders/{oid}")

    def test_failure_retry_flow(self, api, products):
        prs = api.get(f"{BASE_URL}/api/printers").json()
        bar = next(p for p in prs if p["name"] == "Bar Printer #1")
        # Take bar offline
        api.patch(f"{BASE_URL}/api/printers/{bar['id']}", json={"online": False})
        drink = _find(products, "Neon Negroni")
        table = _free_table(api)
        payload = {
            "order_type": "dine_in", "table_id": table["id"], "guests": 1,
            "service_charge_pct": 10.0,
            "lines": [{"product_id": drink["id"], "name": drink["name"], "price": drink["price"], "qty": 1,
                       "course": "drink", "seat": 1, "held": True, "kind": "drink"}],
        }
        cr = api.post(f"{BASE_URL}/api/orders", json=payload)
        oid = cr.json()["id"]
        try:
            api.post(f"{BASE_URL}/api/orders/{oid}/fire")
            jobs = api.get(f"{BASE_URL}/api/print-jobs").json()
            failed = [j for j in jobs if j["order_id"] == oid and j["status"] == "failed"]
            assert failed, f"expected failed print job, got {[j for j in jobs if j['order_id']==oid]}"
            fjid = failed[0]["id"]
            # Alert
            alerts = api.get(f"{BASE_URL}/api/alerts").json()
            assert any(a["kind"] == "print" for a in alerts[:10]), "expected print alert"
            # Bring back online + retry
            api.patch(f"{BASE_URL}/api/printers/{bar['id']}", json={"online": True})
            rr = api.post(f"{BASE_URL}/api/print-jobs/{fjid}/retry")
            assert rr.status_code == 200, rr.text
            assert rr.json()["status"] == "printed"
        finally:
            api.delete(f"{BASE_URL}/api/orders/{oid}")

    def test_receipt_on_pay(self, api, products):
        drink = _find(products, "Neon Negroni")
        table = _free_table(api)
        cr = api.post(f"{BASE_URL}/api/orders", json={
            "order_type": "dine_in", "table_id": table["id"], "guests": 1,
            "service_charge_pct": 10.0,
            "lines": [{"product_id": drink["id"], "name": drink["name"], "price": drink["price"], "qty": 1,
                       "course": "drink", "seat": 1, "kind": "drink"}],
        })
        oid = cr.json()["id"]
        total = cr.json()["total"]
        pay = api.post(f"{BASE_URL}/api/orders/{oid}/pay",
                       json={"method": "cash", "amount": total, "tip": 0, "splits": []})
        assert pay.status_code == 200, pay.text
        jobs = api.get(f"{BASE_URL}/api/print-jobs").json()
        assert any(j["order_id"] == oid and j["job_type"] == "receipt" and j["printer_name"] == "Cashier Receipt"
                   for j in jobs), "receipt job missing"


# --- Inventory ---
class TestInventory:
    def test_deduction_variant_and_modifier(self, api, products):
        drink = _find(products, "Neon Negroni")
        food = _find(products, "Truffle Fries")
        # Idempotency: restock first so repeated runs never hit the negative-stock guard
        _restock(api, ["Gin", "Campari", "Sweet Vermouth", "Fries (frozen)", "Parmesan"], 5000)
        ing_before = {i["name"]: i["qty"] for i in api.get(f"{BASE_URL}/api/ingredients").json()}
        table = _free_table(api)
        cr = api.post(f"{BASE_URL}/api/orders", json={
            "order_type": "dine_in", "table_id": table["id"], "guests": 1,
            "service_charge_pct": 10.0,
            "lines": [
                {"product_id": drink["id"], "name": drink["name"], "price": drink["price"], "qty": 2,
                 "course": "drink", "seat": 1, "variant": "Double", "kind": "drink"},
                {"product_id": food["id"], "name": food["name"], "price": food["price"], "qty": 1,
                 "course": "food", "seat": 1, "modifiers": ["Extra Parmesan"], "kind": "food"},
            ],
        })
        assert cr.status_code == 200, cr.text
        oid = cr.json()["id"]
        total = cr.json()["total"]
        pay = api.post(f"{BASE_URL}/api/orders/{oid}/pay",
                       json={"method": "cash", "amount": total, "tip": 0, "splits": []})
        assert pay.status_code == 200
        ing_after = {i["name"]: i["qty"] for i in api.get(f"{BASE_URL}/api/ingredients").json()}
        # Neon Negroni Double = 60ml Gin/Campari/Vermouth per drink * 2 = 120ml each
        for name, delta in [("Gin", 120), ("Campari", 120), ("Sweet Vermouth", 120)]:
            got = round(ing_before[name] - ing_after[name], 2)
            assert got == pytest.approx(delta, abs=0.5), f"{name} expected -{delta}, got -{got}"
        # Truffle Fries base 200g + Parmesan modifier 10g
        assert round(ing_before["Fries (frozen)"] - ing_after["Fries (frozen)"], 2) == pytest.approx(200, abs=0.5)
        assert round(ing_before["Parmesan"] - ing_after["Parmesan"], 2) == pytest.approx(10, abs=0.5)

    def test_restock(self, api):
        ings = api.get(f"{BASE_URL}/api/ingredients").json()
        gin = next(i for i in ings if i["name"] == "Gin")
        before = gin["qty"]
        r = api.post(f"{BASE_URL}/api/ingredients/{gin['id']}/restock", json={"qty": 50, "note": "TEST"})
        assert r.status_code == 200
        after = r.json()["qty"]
        assert round(after - before, 2) == pytest.approx(50, abs=0.5)

    def test_wastage_with_reason(self, api):
        ings = api.get(f"{BASE_URL}/api/ingredients").json()
        gin = next(i for i in ings if i["name"] == "Gin")
        before = gin["qty"]
        r = api.post(f"{BASE_URL}/api/ingredients/{gin['id']}/wastage", json={"qty": 10, "reason": "TEST_spill"})
        assert r.status_code == 200
        assert round(before - r.json()["qty"], 2) == pytest.approx(10, abs=0.5)

    def test_wastage_clamps_negative(self, api):
        # create ingredient with small qty to force clamp
        c = api.post(f"{BASE_URL}/api/ingredients",
                     json={"name": "TEST_Ing_Clamp", "unit": "ml", "qty": 5, "par_level": 0})
        assert c.status_code == 200
        iid = c.json()["id"]
        try:
            r = api.post(f"{BASE_URL}/api/ingredients/{iid}/wastage", json={"qty": 500, "reason": "TEST"})
            assert r.status_code == 200
            assert r.json()["qty"] == 0
            movs = api.get(f"{BASE_URL}/api/inventory/movements").json()
            hit = [m for m in movs if m["ingredient_id"] == iid and m["type"] == "wastage"]
            assert hit and hit[0]["delta"] == -5
        finally:
            api.delete(f"{BASE_URL}/api/ingredients/{iid}")

    def test_low_stock_alert(self, api):
        c = api.post(f"{BASE_URL}/api/ingredients",
                     json={"name": "TEST_LowStock", "unit": "ml", "qty": 5, "par_level": 10})
        iid = c.json()["id"]
        try:
            rows = api.get(f"{BASE_URL}/api/ingredients").json()
            row = next(x for x in rows if x["id"] == iid)
            assert row["low"] == True
        finally:
            api.delete(f"{BASE_URL}/api/ingredients/{iid}")


# --- Card terminal ---
class TestCardTerminal:
    def _mk_order(self, api, products):
        drink = _find(products, "Neon Negroni")
        table = _free_table(api)
        cr = api.post(f"{BASE_URL}/api/orders", json={
            "order_type": "dine_in", "table_id": table["id"], "guests": 1,
            "service_charge_pct": 10.0,
            "lines": [{"product_id": drink["id"], "name": drink["name"], "price": drink["price"], "qty": 1,
                       "course": "drink", "seat": 1, "kind": "drink"}],
        })
        return cr.json()

    def test_terminal_402_without_approval(self, api, products):
        o = self._mk_order(api, products)
        r = api.post(f"{BASE_URL}/api/orders/{o['id']}/pay",
                     json={"method": "card_terminal", "amount": o["total"], "tip": 0, "splits": []})
        assert r.status_code == 402, r.text
        api.delete(f"{BASE_URL}/api/orders/{o['id']}")

    def test_terminal_approved(self, api, products):
        o = self._mk_order(api, products)
        r = api.post(f"{BASE_URL}/api/orders/{o['id']}/pay",
                     json={"method": "card_terminal", "amount": o["total"], "tip": 0, "splits": [],
                           "terminal_approved": True, "terminal_ref": "TEST-REF-123"})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["status"] == "paid"
        assert data["payment"]["terminal"]["provider"] == "manual"
        assert data["payment"]["terminal"]["status"] == "approved"


# --- HR ---
class TestShiftsHours:
    def test_hours_endpoint(self, api):
        r = api.get(f"{BASE_URL}/api/shifts/hours")
        assert r.status_code == 200, r.text
        rows = r.json()
        assert isinstance(rows, list)
        if rows:
            row = rows[0]
            for k in ("user_id", "name", "hours", "shifts", "hourly_rate", "gross_pay"):
                assert k in row, f"missing {k} in {row}"


# --- Cloud mirror ---
class TestCloudMirror:
    def test_sync_now(self, api):
        r = api.post(f"{BASE_URL}/api/cloud/sync")
        assert r.status_code == 200, r.text
        assert r.json()["ok"] == True

    def test_status(self, api):
        r = api.get(f"{BASE_URL}/api/cloud/status")
        assert r.status_code == 200
        s = r.json()
        assert s.get("mirror_url")
        assert s.get("last_sync_status") == "ok"

    def test_cloud_report_direct_with_key(self):
        r = requests.get(f"{CLOUD_URL}/cloud/api/report", headers={"X-API-Key": CLOUD_KEY}, timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "latest" in data
        latest = data["latest"]
        assert latest and "sales" in latest and "inventory" in latest and "low_stock" in latest

    def test_cloud_report_wrong_key_401(self):
        r = requests.get(f"{CLOUD_URL}/cloud/api/report", headers={"X-API-Key": "WRONG"}, timeout=10)
        assert r.status_code == 401

    def test_cloud_proxy_report(self, api):
        r = api.get(f"{BASE_URL}/api/cloud/report")
        assert r.status_code == 200
        assert "latest" in r.json()


# --- Split/Merge regression ---
class TestSplitMerge:
    def test_split_equal_pay(self, api, products):
        drink = _find(products, "Neon Negroni")
        table = _free_table(api)
        cr = api.post(f"{BASE_URL}/api/orders", json={
            "order_type": "dine_in", "table_id": table["id"], "guests": 2,
            "service_charge_pct": 10.0,
            "lines": [{"product_id": drink["id"], "name": drink["name"], "price": drink["price"], "qty": 2,
                       "course": "drink", "seat": 1, "kind": "drink"}],
        })
        o = cr.json()
        half = round(o["total"] / 2, 2)
        r = api.post(f"{BASE_URL}/api/orders/{o['id']}/pay",
                     json={"method": "split", "amount": o["total"], "tip": 0,
                           "splits": [{"method": "cash", "amount": half},
                                      {"method": "cash", "amount": o["total"] - half}]})
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "paid"

    def test_merge_orders(self, api, products):
        drink = _find(products, "Neon Negroni")
        t1 = _free_table(api)
        o1 = api.post(f"{BASE_URL}/api/orders", json={
            "order_type": "dine_in", "table_id": t1["id"], "guests": 1,
            "service_charge_pct": 10.0,
            "lines": [{"product_id": drink["id"], "name": drink["name"], "price": drink["price"],
                       "qty": 1, "course": "drink", "seat": 1, "kind": "drink"}],
        }).json()
        t2 = _free_table(api)
        o2 = api.post(f"{BASE_URL}/api/orders", json={
            "order_type": "dine_in", "table_id": t2["id"], "guests": 1,
            "service_charge_pct": 10.0,
            "lines": [{"product_id": drink["id"], "name": drink["name"], "price": drink["price"],
                       "qty": 1, "course": "drink", "seat": 1, "kind": "drink"}],
        }).json()
        try:
            m = api.post(f"{BASE_URL}/api/orders/merge",
                         json={"source_id": o2["id"], "target_id": o1["id"]})
            assert m.status_code == 200, m.text
            merged = m.json()
            assert merged.get("ok") == True
            assert merged.get("line_count", 0) >= 2
        finally:
            api.delete(f"{BASE_URL}/api/orders/{o1['id']}")
