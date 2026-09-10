"""Idempotent seed data for HK Bar POS."""
import os
from datetime import datetime, timezone
from auth import hash_password, verify_password


async def seed_all(db):
    await _seed_users(db)
    await _seed_areas_and_tables(db)
    await _seed_menu(db)
    await _seed_members(db)
    await _seed_happy_hours(db)
    await _seed_kegs(db)
    await _seed_combos(db)
    await _seed_printers(db)
    await _seed_ingredients(db)
    await _seed_loyalty(db)
    await _seed_screens(db)
    await _seed_keg_costs_and_pours(db)


async def _seed_loyalty(db):
    if not await db.settings.find_one({"key": "loyalty"}):
        await db.settings.insert_one({
            "key": "loyalty",
            "points_per_hkd": 0.1,
            "tier_multipliers": {"Regular": 1.0, "Silver": 1.25, "Gold": 1.5, "VIP": 2.0},
            "coupon_points_cost": 100,
            "coupon_value": 10.0,
        })


async def _seed_screens(db):
    if await db.screens.count_documents({}) > 0:
        return
    now = datetime.now(timezone.utc).isoformat()
    await db.screens.insert_many([
        {"name": "TV 1 · Main Bar", "location": "Above main bar", "notes": "75\" — primary football", "created_at": now},
        {"name": "TV 2 · Terrace", "location": "Terrace wall", "notes": "Outdoor, weatherproof", "created_at": now},
        {"name": "TV 3 · Backroom", "location": "Dart area", "notes": "Motorsport / secondary", "created_at": now},
        {"name": "Projector · VIP", "location": "VIP booth", "notes": "Big matches only", "created_at": now},
    ])


async def _seed_keg_costs_and_pours(db):
    """Idempotent enrichment: give existing demo kegs a cost + set draught variant
    pour sizes so auto stock deduction + cost-per-pour work out of the box."""
    async for k in db.kegs.find({"cost": {"$exists": False}}):
        await db.kegs.update_one({"_id": k["_id"]}, {"$set": {
            "cost": 1450.0, "supplier": "HK Draught Co.",
            "purchase_date": None, "install_date": None,
        }})
    # Draught pour sizes per variant (ml). Pint uses custom 568.
    POURS = {
        "Tsingtao": {"Pint": 568, "Tower": 2000},
        "Craft IPA": {"Pint": 568, "Half": 300},
        "San Miguel": {"Bottle": 330},
    }
    for name, vmap in POURS.items():
        p = await db.products.find_one({"name": name})
        if not p:
            continue
        variants = p.get("variants") or []
        changed = False
        for v in variants:
            if v.get("name") in vmap and not v.get("pour_ml"):
                v["pour_ml"] = vmap[v["name"]]
                changed = True
        if changed:
            await db.products.update_one({"_id": p["_id"]}, {"$set": {"variants": variants}})


async def _seed_printers(db):
    """LAN printers on static IPs. SIMULATION mode until python-escpos is wired
    to real hardware — `online` flag drives printed/failed for demo + retry UX."""
    if await db.printers.count_documents({}) > 0:
        return
    now = datetime.now(timezone.utc).isoformat()
    await db.printers.insert_many([
        {"name": "Bar Printer #1", "ip": "192.168.1.101", "port": 9100, "role": "bar", "online": True, "active": True, "created_at": now},
        {"name": "Kitchen Printer #1", "ip": "192.168.1.102", "port": 9100, "role": "kitchen", "online": True, "active": True, "created_at": now},
        {"name": "Cashier Receipt", "ip": "192.168.1.103", "port": 9100, "role": "receipt", "online": True, "active": True, "created_at": now},
    ])


async def _seed_ingredients(db):
    """Ingredient master + per-product BOM recipes. Keg-tracked draught beers are
    intentionally skipped — the keg ledger already measures those pours."""
    if await db.ingredients.count_documents({}) == 0:
        now = datetime.now(timezone.utc).isoformat()
        docs = [
            ("Gin", "ml", 1400, 350, 0.42), ("Vodka", "ml", 1400, 350, 0.40),
            ("Campari", "ml", 700, 150, 0.35), ("Sweet Vermouth", "ml", 700, 150, 0.22),
            ("Bourbon", "ml", 700, 150, 0.55), ("Lychee Liqueur", "ml", 700, 150, 0.38),
            ("JW Black Label", "ml", 700, 150, 0.50), ("Tequila", "ml", 700, 150, 0.48),
            ("Lime Juice", "ml", 1200, 300, 0.05), ("Cola (postmix)", "ml", 10000, 2000, 0.02),
            ("Sparkling Water", "ml", 6600, 1320, 0.02),
            ("Chicken Wings", "pcs", 120, 30, 2.5), ("Fries (frozen)", "g", 8000, 2000, 0.01),
            ("Parmesan", "g", 500, 100, 0.08), ("Squid (frozen)", "g", 3000, 600, 0.06),
            ("Beef Patty", "pcs", 40, 10, 9.0), ("Bacon", "pcs", 60, 12, 1.5),
            ("Cheese Slice", "pcs", 60, 12, 1.2), ("Ribeye 250g", "pcs", 20, 5, 38.0),
            ("Fish Fillet", "pcs", 30, 8, 7.0), ("Rice Noodles", "g", 4000, 800, 0.02),
            ("Coleslaw Mix", "g", 2000, 400, 0.015), ("Onion Rings", "g", 2500, 500, 0.02),
            ("Lava Cake (frozen)", "pcs", 24, 6, 6.5), ("Vanilla Ice Cream", "scoops", 60, 12, 1.8),
        ]
        await db.ingredients.insert_many([
            {"name": n, "unit": u, "qty": q, "par_level": p, "cost_per_unit": c, "created_at": now}
            for n, u, q, p, c in docs
        ])

    ings = {i["name"]: str(i["_id"]) async for i in db.ingredients.find()}
    if not ings:
        return

    def r(*pairs):
        return [{"ingredient_id": ings[n], "qty": q} for n, q in pairs]

    # name -> (base recipe, variant_recipes, {modifier_name: recipe})
    RECIPES = {
        "Hong Kong Sour": (r(("Gin", 45), ("Lime Juice", 20)), {"Double": r(("Gin", 90), ("Lime Juice", 40))}, {"Extra Lime": r(("Lime Juice", 10))}),
        "Neon Negroni": (r(("Gin", 30), ("Campari", 30), ("Sweet Vermouth", 30)), {"Double": r(("Gin", 60), ("Campari", 60), ("Sweet Vermouth", 60))}, {}),
        "Lychee Martini": (r(("Vodka", 45), ("Lychee Liqueur", 30)), {}, {}),
        "Old Fashioned": (r(("Bourbon", 45),), {}, {}),
        "Johnnie Walker Black": (r(("JW Black Label", 30),), {"Double": r(("JW Black Label", 60))}, {"With Coke": r(("Cola (postmix)", 150))}),
        "Jose Cuervo": (r(("Tequila", 30),), {"Double Shot": r(("Tequila", 60))}, {}),
        "Coke": (r(("Cola (postmix)", 330),), {}, {}),
        "Sparkling Water": (r(("Sparkling Water", 330),), {}, {}),
        "Truffle Fries": (r(("Fries (frozen)", 200),), {}, {"Extra Parmesan": r(("Parmesan", 10))}),
        "Chicken Wings": (r(("Chicken Wings", 6),), {}, {}),
        "Salt & Pepper Squid": (r(("Squid (frozen)", 180),), {}, {}),
        "Wagyu Burger": (r(("Beef Patty", 1),), {}, {"Add Bacon": r(("Bacon", 1)), "Add Cheese": r(("Cheese Slice", 1))}),
        "Ribeye Steak 250g": (r(("Ribeye 250g", 1),), {}, {}),
        "Fish & Chips": (r(("Fish Fillet", 1), ("Fries (frozen)", 150)), {}, {}),
        "Pad Thai": (r(("Rice Noodles", 150),), {}, {}),
        "Coleslaw": (r(("Coleslaw Mix", 120),), {}, {}),
        "Onion Rings": (r(("Onion Rings", 150),), {}, {}),
        "Chocolate Lava": (r(("Lava Cake (frozen)", 1),), {}, {"Ice Cream": r(("Vanilla Ice Cream", 1))}),
    }
    async for p in db.products.find({"name": {"$in": list(RECIPES)}}):
        if p.get("recipe"):
            continue
        base, vrec, mrec = RECIPES[p["name"]]
        mods = []
        for m in p.get("modifiers") or []:
            m = dict(m)
            if m.get("name") in mrec:
                m["recipe"] = mrec[m["name"]]
            mods.append(m)
        await db.products.update_one({"_id": p["_id"]},
            {"$set": {"recipe": base, "variant_recipes": vrec, "modifiers": mods}})


async def _seed_combos(db):
    """Idempotent — inserts advanced slot-based demo combos so a fresh install
    shows the new Combo procedure (AND/OR + min/max qty) in the Register."""
    if await db.combos.count_documents({}) > 0:
        return

    async def _find(names):
        return [p async for p in db.products.find({"name": {"$in": names}})]

    signature = await _find(["Hong Kong Sour", "Neon Negroni", "Lychee Martini"])
    classic = await _find(["Old Fashioned", "Johnnie Walker Black"])
    draught = await _find(["Tsingtao", "Craft IPA", "San Miguel"])
    snacks = await _find(["Truffle Fries", "Chicken Wings", "Salt & Pepper Squid"])
    mains = await _find(["Wagyu Burger", "Ribeye Steak 250g", "Fish & Chips", "Pad Thai"])

    def ids(lst):
        return [str(p["_id"]) for p in lst]

    now = datetime.now(timezone.utc).isoformat()
    combos = []
    if signature and classic:
        combos.append({
            "name": "Cocktail Duo",
            "product_ids": [],
            "slots": [
                {"operator": "or", "min_qty": 1, "max_qty": 1, "product_ids": ids(signature)},
                {"operator": "or", "min_qty": 1, "max_qty": 1, "product_ids": ids(classic)},
            ],
            "discount_type": "percent", "discount_value": 15.0,
            "active": True, "created_at": now,
        })
    if draught and snacks:
        combos.append({
            "name": "Beer & Bites",
            "product_ids": [],
            "slots": [
                {"operator": "or", "min_qty": 1, "max_qty": 2, "product_ids": ids(draught)},
                {"operator": "or", "min_qty": 1, "max_qty": 2, "product_ids": ids(snacks)},
            ],
            "discount_type": "cash", "discount_value": 25.0,
            "active": True, "created_at": now,
        })
    if mains:
        combos.append({
            "name": "Steak Night · any 2 mains",
            "product_ids": [],
            "slots": [
                {"operator": "or", "min_qty": 2, "max_qty": 2, "product_ids": ids(mains)},
            ],
            "discount_type": "cash", "discount_value": 40.0,
            "active": True, "created_at": now,
        })

    if combos:
        await db.combos.insert_many(combos)


async def _seed_kegs(db):
    if await db.kegs.count_documents({}) > 0:
        return
    from datetime import datetime, timezone
    # link kegs to beer products by name
    beer_names = ["Tsingtao", "Craft IPA", "San Miguel"]
    prods = {p["name"]: p async for p in db.products.find({"name": {"$in": beer_names}})}
    kegs = []
    tap = 1
    for beer_name, size, pour in [
        ("Tsingtao", 30000, 568),
        ("Craft IPA", 30000, 568),
        ("San Miguel", 30000, 500),
    ]:
        p = prods.get(beer_name)
        if not p:
            continue
        # Two kegs per beer (main + backup) to demonstrate 35+ taps at scale
        for backup in [False, True]:
            kegs.append({
                "name": f"Tap {tap:02d} · {beer_name}{' (backup)' if backup else ''}",
                "product_id": str(p["_id"]),
                "size_ml": size,
                "current_ml": int(size * (0.08 if (tap == 1) else 1.0)),  # tap 1 low for demo
                "ml_per_pour": pour,
                "threshold_pct": 10.0,
                "status": "on",
                "opened_at": datetime.now(timezone.utc).isoformat(),
                "created_at": datetime.now(timezone.utc).isoformat(),
            })
            tap += 1
    if kegs:
        await db.kegs.insert_many(kegs)


async def _seed_users(db):
    admin_email = os.environ.get("ADMIN_EMAIL", "admin@example.com")
    admin_pass = os.environ.get("ADMIN_PASSWORD", "admin123")
    admin_pin = os.environ.get("ADMIN_PIN", "9999")

    # Retire demo staff — real roster below
    await db.users.update_many(
        {"email": {"$in": ["manager@hkbar.com", "bartender@hkbar.com", "server@hkbar.com", "cashier@hkbar.com"]}},
        {"$set": {"active": False}},
    )
    users = [
        (admin_email, admin_pass, "Owner", "owner", admin_pin, 0.0),
        ("steph@belly.com", "Steph", "Steph", "owner", "666", 0.0),
        ("mandy@belly.com", "Mandy", "Mandy", "owner", "888", 0.0),
        ("admin@belly.com", "BellyBeer21", "Belly Admin", "admin", "0000", 0.0),
        ("cindy@belly.com", "belly123", "Cindy", "manager", "111", 90.0),
        ("mavis@belly.com", "belly123", "Mavis", "assistant_manager", "222", 80.0),
        ("shrey@belly.com", "belly123", "Shrey", "assistant_manager", "333", 80.0),
        ("kat@belly.com", "belly123", "Kat", "assistant_manager", "555", 80.0),
        ("john@belly.com", "belly123", "John", "front_of_house", "777", 65.0),
        ("ayi@belly.com", "belly123", "Ayi", "kitchen", "999", 65.0),
    ]
    for email, pwd, name, role, pin, rate in users:
        existing = await db.users.find_one({"email": email})
        if not existing:
            await db.users.insert_one({
                "email": email,
                "password_hash": hash_password(pwd),
                "name": name,
                "role": role,
                "pin": pin,
                "hourly_rate": rate,
                "active": True,
                "created_at": datetime.now(timezone.utc).isoformat(),
            })
        else:
            update = {"role": role, "pin": pin, "name": name, "hourly_rate": rate}
            if not verify_password(pwd, existing["password_hash"]):
                update["password_hash"] = hash_password(pwd)
            await db.users.update_one({"_id": existing["_id"]}, {"$set": update})


async def _seed_areas_and_tables(db):
    areas = {}
    for name in ["Main+Terrace", "Backroom"]:
        existing = await db.areas.find_one({"name": name})
        if existing:
            areas[name] = existing["_id"]
        else:
            r = await db.areas.insert_one({"name": name, "created_at": datetime.now(timezone.utc).isoformat()})
            areas[name] = r.inserted_id

    if await db.tables.count_documents({}) > 0:
        return

    layout = [
        # Main+Terrace
        ("Main+Terrace", "T1", 4, 60, 60, 100, 100, "rect"),
        ("Main+Terrace", "T2", 4, 200, 60, 100, 100, "rect"),
        ("Main+Terrace", "T3", 4, 340, 60, 100, 100, "rect"),
        ("Main+Terrace", "T4", 2, 60, 200, 80, 80, "circle"),
        ("Main+Terrace", "T5", 2, 180, 200, 80, 80, "circle"),
        ("Main+Terrace", "T6", 6, 300, 200, 160, 90, "rect"),
        ("Main+Terrace", "Bar1", 1, 500, 60, 60, 60, "circle"),
        ("Main+Terrace", "Bar2", 1, 500, 140, 60, 60, "circle"),
        ("Main+Terrace", "Bar3", 1, 500, 220, 60, 60, "circle"),
        ("Main+Terrace", "Terr1", 4, 60, 340, 100, 100, "rect"),
        ("Main+Terrace", "Terr2", 4, 200, 340, 100, 100, "rect"),
        ("Main+Terrace", "Terr3", 6, 340, 340, 160, 100, "rect"),
        # Backroom
        ("Backroom", "B1", 4, 60, 60, 110, 90, "rect"),
        ("Backroom", "B2", 4, 200, 60, 110, 90, "rect"),
        ("Backroom", "B3", 8, 60, 200, 250, 100, "rect"),
        ("Backroom", "Dart1", 2, 360, 60, 90, 90, "circle"),
        ("Backroom", "Dart2", 2, 360, 180, 90, 90, "circle"),
        ("Backroom", "VIP", 8, 60, 340, 400, 110, "rect"),
    ]
    docs = []
    for area_name, tname, seats, x, y, w, h, shape in layout:
        docs.append({
            "area_id": str(areas[area_name]),
            "name": tname,
            "seats": seats,
            "x": x, "y": y, "width": w, "height": h, "shape": shape,
            "status": "available",
            "current_order_id": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
    if docs:
        await db.tables.insert_many(docs)


async def _seed_menu(db):
    if await db.categories.count_documents({}) > 0:
        return
    cats = [
        ("Cocktails", "drink", "#00F2FE"),
        ("Beer", "drink", "#FFB800"),
        ("Wine", "drink", "#A855F7"),
        ("Spirits", "drink", "#F43F5E"),
        ("Soft Drinks", "drink", "#10B981"),
        ("Starters", "food", "#F59E0B"),
        ("Mains", "food", "#06B6D4"),
        ("Sides", "food", "#94A3B8"),
        ("Desserts", "food", "#EC4899"),
    ]
    cat_ids = {}
    for name, kind, color in cats:
        r = await db.categories.insert_one({
            "name": name, "kind": kind, "color": color, "parent_id": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        cat_ids[name] = str(r.inserted_id)

    products = [
        # Cocktails
        ("Hong Kong Sour", "Cocktails", 118, "drink", True,
            [{"name": "Single", "price_delta": 0}, {"name": "Double", "price_delta": 40}],
            [{"name": "No Ice", "price_delta": 0}, {"name": "Extra Lime", "price_delta": 5}]),
        ("Neon Negroni", "Cocktails", 128, "drink", True,
            [{"name": "Single", "price_delta": 0}, {"name": "Double", "price_delta": 45}],
            [{"name": "Orange Peel", "price_delta": 0}]),
        ("Lychee Martini", "Cocktails", 122, "drink", True, [], []),
        ("Old Fashioned", "Cocktails", 138, "drink", True, [], [{"name": "Extra Cherry", "price_delta": 5}]),
        # Beer
        ("Tsingtao", "Beer", 55, "drink", True,
            [{"name": "Pint", "price_delta": 0}, {"name": "Tower", "price_delta": 220}, {"name": "Bucket x6", "price_delta": 250}],
            []),
        ("Craft IPA", "Beer", 75, "drink", True,
            [{"name": "Pint", "price_delta": 0}, {"name": "Half", "price_delta": -30}], []),
        ("San Miguel", "Beer", 50, "drink", True,
            [{"name": "Bottle", "price_delta": 0}, {"name": "Bucket x6", "price_delta": 220}], []),
        # Wine
        ("House Red Glass", "Wine", 78, "drink", True, [{"name": "Glass", "price_delta": 0}, {"name": "Bottle", "price_delta": 220}], []),
        ("House White Glass", "Wine", 78, "drink", True, [{"name": "Glass", "price_delta": 0}, {"name": "Bottle", "price_delta": 220}], []),
        # Spirits
        ("Johnnie Walker Black", "Spirits", 95, "drink", True,
            [{"name": "Single", "price_delta": 0}, {"name": "Double", "price_delta": 60}],
            [{"name": "Neat", "price_delta": 0}, {"name": "On Rocks", "price_delta": 0}, {"name": "With Coke", "price_delta": 10}]),
        ("Jose Cuervo", "Spirits", 85, "drink", True, [{"name": "Shot", "price_delta": 0}, {"name": "Double Shot", "price_delta": 50}], []),
        # Soft
        ("Coke", "Soft Drinks", 35, "drink", False, [], [{"name": "No Ice", "price_delta": 0}]),
        ("Sparkling Water", "Soft Drinks", 40, "drink", False, [], []),
        # Food
        ("Truffle Fries", "Starters", 88, "food", False, [], [{"name": "Extra Parmesan", "price_delta": 10}]),
        ("Chicken Wings", "Starters", 98, "food", False,
            [{"name": "Original", "price_delta": 0}, {"name": "Hot", "price_delta": 0}, {"name": "BBQ", "price_delta": 0}], []),
        ("Salt & Pepper Squid", "Starters", 118, "food", False, [], []),
        ("Wagyu Burger", "Mains", 168, "food", False,
            [{"name": "Medium Rare", "price_delta": 0}, {"name": "Medium", "price_delta": 0}, {"name": "Well Done", "price_delta": 0}],
            [{"name": "Add Bacon", "price_delta": 20}, {"name": "Add Cheese", "price_delta": 15}]),
        ("Ribeye Steak 250g", "Mains", 288, "food", False,
            [{"name": "Rare", "price_delta": 0}, {"name": "Medium Rare", "price_delta": 0}, {"name": "Medium", "price_delta": 0}, {"name": "Well Done", "price_delta": 0}],
            [{"name": "Peppercorn Sauce", "price_delta": 25}, {"name": "Mushroom Sauce", "price_delta": 25}]),
        ("Fish & Chips", "Mains", 148, "food", False, [], []),
        ("Pad Thai", "Mains", 118, "food", False, [{"name": "Chicken", "price_delta": 0}, {"name": "Prawn", "price_delta": 25}, {"name": "Veg", "price_delta": -10}], []),
        ("Coleslaw", "Sides", 38, "food", False, [], []),
        ("Onion Rings", "Sides", 48, "food", False, [], []),
        ("Chocolate Lava", "Desserts", 78, "food", False, [], [{"name": "Ice Cream", "price_delta": 15}]),
    ]
    docs = []
    course_map = {"Starters": "starter", "Mains": "main", "Sides": "side", "Desserts": "dessert"}
    for name, cat, price, kind, hh, variants, mods in products:
        docs.append({
            "name": name,
            "category_id": cat_ids[cat],
            "price": price,
            "kind": kind,
            "course": course_map.get(cat, "drink"),
            "variants": variants,
            "modifiers": mods,
            "happy_hour_eligible": hh,
            "description": "",
            "image": None,
            "active": True,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
    if docs:
        await db.products.insert_many(docs)


async def _seed_members(db):
    if await db.members.count_documents({}) > 0:
        return
    members = [
        ("Jason Lee", "+852 9123 4567", "jason@hk.com", "VIP"),
        ("Priya Sharma", "+852 9876 5432", "priya@hk.com", "Gold"),
        ("Marco Rossi", "+852 9111 2222", "marco@hk.com", "Silver"),
        ("Karen Chow", "+852 9333 4444", "karen@hk.com", "Regular"),
        ("Daniel Kim", "+852 9555 6666", "daniel@hk.com", "Gold"),
    ]
    docs = []
    for n, p, e, t in members:
        docs.append({
            "name": n, "phone": p, "email": e, "tier": t, "notes": "",
            "lifetime_spend": 0.0, "visits": 0, "points": 0,
            "favorite_items": [],
            "avg_duration_min": 0,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
    if docs:
        await db.members.insert_many(docs)


async def _seed_happy_hours(db):
    if await db.happy_hours.count_documents({}) > 0:
        return
    cocktails = await db.categories.find_one({"name": "Cocktails"})
    beer = await db.categories.find_one({"name": "Beer"})
    cat_ids = [str(c["_id"]) for c in [cocktails, beer] if c]
    await db.happy_hours.insert_one({
        "name": "Daily Happy Hour",
        "days": [0, 1, 2, 3, 4, 5, 6],
        "start_time": "16:00",
        "end_time": "21:00",
        "percent_off": 20.0,
        "category_ids": cat_ids,
        "active": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
