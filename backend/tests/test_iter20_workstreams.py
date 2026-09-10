"""Iter 20 workstreams: loyalty, members-live-tab, kegs cost intel,
selective line actions, screens/broadcasts, fixtures, permissions."""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://live-tap-management.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


# ---------- Auth fixtures ----------
def _login(email, password):
    s = requests.Session()
    r = s.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=15)
    assert r.status_code == 200, f"login failed {email}: {r.status_code} {r.text}"
    return s, r.json()["token"]


@pytest.fixture(scope="session")
def owner_session():
    s, _ = _login("lunalunamoonshine@gmail.com", "admin123")
    return s


@pytest.fixture(scope="session")
def foh_session():
    s, _ = _login("john@belly.com", "belly123")
    return s


@pytest.fixture(scope="session")
def kitchen_session():
    s, _ = _login("ayi@belly.com", "belly123")
    return s


# ---------- 0. Auth ----------
class TestAuth:
    def test_owner_email_login(self):
        s, tok = _login("lunalunamoonshine@gmail.com", "admin123")
        assert tok
        me = s.get(f"{API}/auth/me").json()
        assert me["role"] == "owner"

    def test_pin_login_owner(self):
        s = requests.Session()
        r = s.post(f"{API}/auth/pin-login", json={"pin": "9999"}, timeout=15)
        assert r.status_code == 200
        assert r.json()["user"]["role"] == "owner"


# ---------- 1. Loyalty config ----------
class TestLoyaltyConfig:
    def test_get_defaults(self, owner_session):
        r = owner_session.get(f"{API}/loyalty/config")
        assert r.status_code == 200
        cfg = r.json()
        assert cfg["points_per_hkd"] == 0.1
        assert cfg["coupon_points_cost"] == 100
        assert cfg["coupon_value"] == 10.0

    def test_put_manager_only(self, owner_session):
        r = owner_session.put(f"{API}/loyalty/config", json={
            "points_per_hkd": 0.1,
            "tier_multipliers": {"Regular": 1.0, "Silver": 1.25, "Gold": 1.5, "VIP": 2.0},
            "coupon_points_cost": 100,
            "coupon_value": 10.0,
        })
        assert r.status_code == 200
        assert r.json()["coupon_points_cost"] == 100

    def test_put_forbidden_for_foh(self, foh_session):
        r = foh_session.put(f"{API}/loyalty/config", json={
            "points_per_hkd": 0.2, "tier_multipliers": {"Regular": 1.0},
            "coupon_points_cost": 100, "coupon_value": 10.0,
        })
        assert r.status_code == 403


# ---------- 2. Members: CRM + tab + adjust + redeem + rewards ----------
@pytest.fixture(scope="module")
def test_member(owner_session):
    r = owner_session.post(f"{API}/members", json={
        "name": "TEST_Iter20_Member", "phone": "+85290000000",
        "tier": "Regular", "notes": "", "member_discount_pct": 0.0,
    })
    assert r.status_code == 200
    mid = r.json()["id"]
    yield mid
    owner_session.delete(f"{API}/members/{mid}")


class TestMembers:
    def test_tab(self, owner_session, test_member):
        r = owner_session.get(f"{API}/members/{test_member}/tab")
        assert r.status_code == 200
        t = r.json()
        assert t["points"] == 0
        assert t["credit_balance"] == 0.0
        assert "open_balance" in t

    def test_adjust_points_manager(self, owner_session, test_member):
        r = owner_session.post(f"{API}/members/{test_member}/adjust", json={
            "field": "points", "delta": 250, "reason": "TEST seed"
        })
        assert r.status_code == 200
        assert r.json()["points"] == 250

    def test_adjust_credit_manager(self, owner_session, test_member):
        r = owner_session.post(f"{API}/members/{test_member}/adjust", json={
            "field": "credit", "delta": 50.0, "reason": "TEST seed"
        })
        assert r.status_code == 200
        assert r.json()["credit_balance"] == 50.0

    def test_adjust_discount_pct(self, owner_session, test_member):
        r = owner_session.post(f"{API}/members/{test_member}/adjust", json={
            "field": "member_discount_pct", "set_value": 5.0, "reason": "vip"
        })
        assert r.status_code == 200
        assert r.json()["member_discount_pct"] == 5.0

    def test_foh_adjust_without_pin_fails(self, foh_session, test_member):
        r = foh_session.post(f"{API}/members/{test_member}/adjust", json={
            "field": "points", "delta": 10, "reason": "no pin"
        })
        assert r.status_code == 403

    def test_foh_adjust_with_manager_pin_ok(self, foh_session, test_member):
        r = foh_session.post(f"{API}/members/{test_member}/adjust", json={
            "field": "points", "delta": 50, "reason": "with pin", "manager_pin": "9999"
        })
        assert r.status_code == 200

    def test_redeem_multiples_only(self, owner_session, test_member):
        r = owner_session.post(f"{API}/members/{test_member}/redeem", json={"points": 150})
        assert r.status_code == 400

    def test_redeem_100_gives_10hkd(self, owner_session, test_member):
        # ensure enough points
        owner_session.post(f"{API}/members/{test_member}/adjust", json={
            "field": "points", "set_value": None, "delta": 500, "reason": "topup"
        })
        # capture before
        before = owner_session.get(f"{API}/members/{test_member}/tab").json()
        r = owner_session.post(f"{API}/members/{test_member}/redeem", json={"points": 100})
        assert r.status_code == 200
        after = owner_session.get(f"{API}/members/{test_member}/tab").json()
        assert after["points"] == before["points"] - 100
        assert round(after["credit_balance"] - before["credit_balance"], 2) == 10.0

    def test_grant_percent_reward(self, owner_session, test_member):
        r = owner_session.post(f"{API}/members/{test_member}/rewards", json={
            "kind": "percent", "value": 10.0
        })
        assert r.status_code == 200
        rewards = r.json().get("rewards", [])
        assert any(rw.get("type") == "percent" for rw in rewards)

    def test_patch_profile_whitelist(self, owner_session, test_member):
        r = owner_session.patch(f"{API}/members/{test_member}", json={
            "name": "TEST_Iter20_Member_Renamed", "phone": "+85290000001"
        })
        assert r.status_code == 200
        assert r.json()["name"] == "TEST_Iter20_Member_Renamed"


# ---------- 3. Auto-earn + credit as tender ----------
@pytest.fixture(scope="module")
def a_product(owner_session):
    prods = owner_session.get(f"{API}/products").json()
    assert prods, "need at least one product seeded"
    return prods[0]


class TestOrdersLoyalty:
    def test_auto_earn_on_pay(self, owner_session, test_member, a_product):
        line = {
            "product_id": a_product["id"], "name": a_product["name"],
            "price": a_product["price"], "qty": 1, "course": "main", "seat": 1,
        }
        # capture current points
        before = owner_session.get(f"{API}/members/{test_member}/tab").json()["points"]
        r = owner_session.post(f"{API}/orders", json={
            "order_type": "pick_up", "member_id": test_member,
            "guests": 1, "lines": [line], "service_charge_pct": 10.0,
        })
        assert r.status_code == 200, r.text
        order = r.json()
        total = order["total"]
        p = owner_session.post(f"{API}/orders/{order['id']}/pay", json={
            "method": "cash", "amount": total + 5, "tip": 0.0,
        })
        assert p.status_code == 200
        assert p.json()["status"] == "paid"
        # points should increase by int(total * 0.1)
        after = owner_session.get(f"{API}/members/{test_member}/tab").json()["points"]
        expected = int(total * 0.1)
        assert after >= before + expected - 1  # allow rounding down

    def test_pay_with_member_credit(self, owner_session, test_member, a_product):
        # ensure member has enough credit
        owner_session.post(f"{API}/members/{test_member}/adjust", json={
            "field": "credit", "delta": 1000.0, "reason": "TEST credit"
        })
        line = {
            "product_id": a_product["id"], "name": a_product["name"],
            "price": a_product["price"], "qty": 1, "course": "main", "seat": 1,
        }
        r = owner_session.post(f"{API}/orders", json={
            "order_type": "pick_up", "member_id": test_member,
            "guests": 1, "lines": [line], "service_charge_pct": 10.0,
        })
        oid = r.json()["id"]
        total = r.json()["total"]
        before_cred = owner_session.get(f"{API}/members/{test_member}/tab").json()["credit_balance"]
        p = owner_session.post(f"{API}/orders/{oid}/pay", json={
            "method": "member_credit", "amount": total,
        })
        assert p.status_code == 200, p.text
        assert p.json()["status"] == "paid"
        after_cred = owner_session.get(f"{API}/members/{test_member}/tab").json()["credit_balance"]
        assert round(before_cred - after_cred, 2) == round(total, 2)

    def test_pay_member_credit_insufficient(self, owner_session, a_product):
        # create fresh member with zero credit
        m = owner_session.post(f"{API}/members", json={
            "name": "TEST_Iter20_ZeroCred", "phone": "+85290000009", "tier": "Regular",
            "notes": "", "member_discount_pct": 0.0,
        }).json()
        try:
            line = {
                "product_id": a_product["id"], "name": a_product["name"],
                "price": a_product["price"], "qty": 1, "course": "main", "seat": 1,
            }
            r = owner_session.post(f"{API}/orders", json={
                "order_type": "pick_up", "member_id": m["id"],
                "guests": 1, "lines": [line], "service_charge_pct": 10.0,
            })
            oid = r.json()["id"]
            total = r.json()["total"]
            p = owner_session.post(f"{API}/orders/{oid}/pay", json={
                "method": "member_credit", "amount": total,
            })
            assert p.status_code == 400
        finally:
            owner_session.delete(f"{API}/members/{m['id']}")


# ---------- 4. Kegs ----------
class TestKegs:
    def test_list_metrics(self, owner_session):
        r = owner_session.get(f"{API}/kegs")
        assert r.status_code == 200
        kegs = r.json()
        if kegs:
            k = kegs[0]
            for f in ("cost_per_pour", "variance_pct", "variance_high", "pours_remaining"):
                assert f in k, f"missing {f}"

    def test_pour_presets(self, owner_session):
        r = owner_session.get(f"{API}/kegs/pour-presets")
        assert r.status_code == 200
        assert r.json()["presets_ml"] == [50, 100, 150, 250, 300, 400, 600]

    def test_create_keg_foh_forbidden(self, foh_session):
        prods = foh_session.get(f"{API}/products").json()
        beer = next((p for p in prods if p.get("kind") == "drink"), prods[0])
        r = foh_session.post(f"{API}/kegs", json={
            "name": "TEST_ForbiddenKeg", "product_id": beer["id"],
            "size_ml": 30000, "ml_per_pour": 568, "cost": 1000.0,
        })
        assert r.status_code == 403


# ---------- 5. Screens & Broadcasts ----------
class TestScreens:
    def test_screens_manager_only(self, foh_session):
        r = foh_session.post(f"{API}/screens", json={"name": "TEST_BadScr"})
        assert r.status_code == 403

    def test_screens_crud_and_broadcast_conflict(self, owner_session):
        # create screen
        s = owner_session.post(f"{API}/screens", json={"name": "TEST_Iter20_Screen"})
        assert s.status_code == 200
        sid = s.json()["id"]
        try:
            # first broadcast
            b1 = owner_session.post(f"{API}/broadcasts", json={
                "screen_id": sid, "channel": "NowTV", "event_title": "TEST_A",
                "sport": "Football",
                "start": "2030-01-01T10:00:00+00:00",
                "end":   "2030-01-01T12:00:00+00:00",
            })
            assert b1.status_code == 200
            assert "start_hkt" in b1.json()
            b1j = b1.json()

            # overlapping second
            b2 = owner_session.post(f"{API}/broadcasts", json={
                "screen_id": sid, "channel": "beIN", "event_title": "TEST_B",
                "sport": "Football",
                "start": "2030-01-01T11:00:00+00:00",
                "end":   "2030-01-01T13:00:00+00:00",
            })
            assert b2.status_code == 200
            assert isinstance(b2.json().get("conflicts"), list)
            assert len(b2.json()["conflicts"]) >= 1  # warn not block

            board = owner_session.get(f"{API}/broadcasts/board").json()
            assert isinstance(board, list)
            entry = next((x for x in board if x["screen"]["id"] == sid), None)
            assert entry is not None

            # cleanup broadcasts
            owner_session.delete(f"{API}/broadcasts/{b1j['id']}")
            owner_session.delete(f"{API}/broadcasts/{b2.json()['id']}")
        finally:
            owner_session.delete(f"{API}/screens/{sid}")


# ---------- 6. Fixtures ----------
class TestFixtures:
    def test_leagues_list(self, owner_session):
        r = owner_session.get(f"{API}/fixtures/leagues")
        assert r.status_code == 200
        leagues = r.json()
        keys = {l["key"] for l in leagues}
        assert {"epl", "gaelic", "olympics"}.issubset(keys)

    def test_epl_fixtures_normalized(self, owner_session):
        r = owner_session.get(f"{API}/fixtures", params={"league_key": "epl"})
        assert r.status_code == 200
        data = r.json()
        assert data["manual_only"] is False
        # fixtures list may be empty depending on feed coverage; if present, verify HKT
        for fx in data["fixtures"][:3]:
            assert "start_hkt" in fx

    def test_manual_only_league(self, owner_session):
        r = owner_session.get(f"{API}/fixtures", params={"league_key": "gaelic"})
        assert r.status_code == 200
        assert r.json()["manual_only"] is True
        assert r.json()["fixtures"] == []


# ---------- 7. Selective line actions ----------
class TestLineActions:
    def _create_order(self, session, product, member_id=None, qty=3):
        line = {
            "product_id": product["id"], "name": product["name"],
            "price": product["price"], "qty": qty, "course": "main", "seat": 1, "held": True,
        }
        r = session.post(f"{API}/orders", json={
            "order_type": "pick_up", "member_id": member_id,
            "guests": 1, "lines": [line, dict(line, seat=2, qty=1)],
            "service_charge_pct": 10.0,
        })
        assert r.status_code == 200, r.text
        return r.json()["id"]

    def test_hold_fire(self, owner_session, a_product):
        oid = self._create_order(owner_session, a_product)
        r = owner_session.post(f"{API}/orders/{oid}/line-action", json={
            "action": "fire", "line_indexes": [0]
        })
        assert r.status_code == 200
        lines = r.json()["order"]["lines"]
        assert lines[0].get("fired_at") is not None
        assert lines[0].get("held") is False

    def test_discount_line(self, owner_session, a_product):
        oid = self._create_order(owner_session, a_product)
        r = owner_session.post(f"{API}/orders/{oid}/line-action", json={
            "action": "discount", "line_indexes": [0], "pct": 25.0
        })
        assert r.status_code == 200
        line = r.json()["order"]["lines"][0]
        assert line.get("line_disc_pct") == 25.0

    def test_move_seat(self, owner_session, a_product):
        oid = self._create_order(owner_session, a_product)
        r = owner_session.post(f"{API}/orders/{oid}/line-action", json={
            "action": "move_seat", "line_indexes": [0], "target_seat": 5
        })
        assert r.status_code == 200
        assert r.json()["order"]["lines"][0]["seat"] == 5

    def test_split_creates_new_order(self, owner_session, a_product):
        oid = self._create_order(owner_session, a_product)
        r = owner_session.post(f"{API}/orders/{oid}/line-action", json={
            "action": "split", "line_indexes": [1]
        })
        assert r.status_code == 200
        body = r.json()
        assert "new_order_id" in body and body["new_order_id"]

    def test_void_requires_manager_pin(self, foh_session, a_product):
        oid = self._create_order(foh_session, a_product)
        # no pin -> 403
        bad = foh_session.post(f"{API}/orders/{oid}/line-action", json={
            "action": "void", "line_indexes": [0]
        })
        assert bad.status_code == 403
        # with pin -> ok
        good = foh_session.post(f"{API}/orders/{oid}/line-action", json={
            "action": "void", "line_indexes": [0], "manager_pin": "9999", "reason": "test"
        })
        assert good.status_code == 200

    def test_comp_owner_ok(self, owner_session, a_product):
        oid = self._create_order(owner_session, a_product)
        r = owner_session.post(f"{API}/orders/{oid}/line-action", json={
            "action": "comp", "line_indexes": [0], "reason": "regular"
        })
        assert r.status_code == 200
        line = r.json()["order"]["lines"][0]
        assert line.get("comped") is True
        assert line["price"] == 0.0
