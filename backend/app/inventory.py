"""Agent inventory, wallets (pebbles), and shops.

Each agent has:
  - A wallet with pebble balance
  - An inventory grid (up to 48 slots)
  - An optional shop listing items for sale

The consistency checker recursively validates all agents' inventories
to ensure slot integrity, balance non-negativity, and quantity limits.
"""

from __future__ import annotations

from typing import Literal

from .db import acquire


# ── Types ────────────────────────────────────────────────────────────

ItemType = Literal["material", "tool", "artifact", "memory", "consumable", "decoration"]
Rarity = Literal["common", "uncommon", "rare", "epic", "legendary"]
TransactionReason = Literal["shop_purchase", "reward_post", "reward_reflection", "transfer", "seed"]


# ── Read helpers ─────────────────────────────────────────────────────


async def get_wallet(agent_id: str) -> dict:
    """Return {agent_id, pebbles, updated_at}."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            "select agent_id, pebbles, updated_at from public.agent_wallets where agent_id = $1",
            agent_id,
        )
    if not row:
        return {"agent_id": agent_id, "pebbles": 0, "updated_at": None}
    return {"agent_id": str(row["agent_id"]), "pebbles": row["pebbles"], "updated_at": str(row["updated_at"])}


async def get_inventory(agent_id: str) -> list[dict]:
    """Return all occupied inventory slots for an agent."""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select ai.slot_index, ai.quantity, ai.item_id,
                   ic.slug, ic.display_name, ic.description, ic.flavor_text,
                   ic.item_type, ic.rarity, ic.icon_url, ic.base_price,
                   ic.stackable, ic.max_stack
              from public.agent_inventory ai
              join public.item_catalog ic on ic.id = ai.item_id
             where ai.agent_id = $1
             order by ai.slot_index
            """,
            agent_id,
        )
    return [
        {
            "slot_index": r["slot_index"],
            "quantity": r["quantity"],
            "item": {
                "id": r["item_id"],
                "slug": r["slug"],
                "display_name": r["display_name"],
                "description": r["description"],
                "flavor_text": r["flavor_text"],
                "item_type": r["item_type"],
                "rarity": r["rarity"],
                "icon_url": r["icon_url"],
                "base_price": r["base_price"],
                "stackable": r["stackable"],
                "max_stack": r["max_stack"],
            },
        }
        for r in rows
    ]


async def get_shop(agent_id: str) -> list[dict]:
    """Return all shop listings for an agent."""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select s.id as listing_id, s.price_pebbles, s.stock,
                   ic.id as item_id, ic.slug, ic.display_name, ic.description,
                   ic.flavor_text, ic.item_type, ic.rarity, ic.icon_url,
                   ic.base_price, ic.stackable, ic.max_stack
              from public.agent_shops s
              join public.item_catalog ic on ic.id = s.item_id
             where s.agent_id = $1
             order by ic.rarity desc, ic.display_name
            """,
            agent_id,
        )
    return [
        {
            "listing_id": r["listing_id"],
            "price_pebbles": r["price_pebbles"],
            "stock": r["stock"],
            "item": {
                "id": r["item_id"],
                "slug": r["slug"],
                "display_name": r["display_name"],
                "description": r["description"],
                "flavor_text": r["flavor_text"],
                "item_type": r["item_type"],
                "rarity": r["rarity"],
                "icon_url": r["icon_url"],
                "base_price": r["base_price"],
                "stackable": r["stackable"],
                "max_stack": r["max_stack"],
            },
        }
        for r in rows
    ]


async def get_item_catalog() -> list[dict]:
    """Return all items in the global catalog."""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            select id, slug, display_name, description, flavor_text,
                   item_type, rarity, icon_url, base_price, stackable, max_stack
              from public.item_catalog
             order by rarity desc, display_name
            """
        )
    return [dict(r) for r in rows]


# ── Mutations ────────────────────────────────────────────────────────


async def buy_from_shop(
    buyer_agent_id: str,
    seller_agent_id: str,
    item_id: int,
    owner_user_id: str,
) -> dict:
    """Buy an item from seller's shop. Deducts pebbles from buyer,
    adds item to buyer's inventory, decrements stock if limited.

    Returns {ok, error?, buyer_pebbles?, slot_index?}.
    """
    async with acquire() as conn:
        async with conn.transaction():
            # Verify both agents owned by this user
            buyer = await conn.fetchrow(
                "select id from public.agents where id = $1 and owner_user_id = $2",
                buyer_agent_id, owner_user_id,
            )
            seller = await conn.fetchrow(
                "select id from public.agents where id = $1 and owner_user_id = $2",
                seller_agent_id, owner_user_id,
            )
            if not buyer or not seller:
                return {"ok": False, "error": "Agent not found or not owned by you"}

            # Get shop listing
            listing = await conn.fetchrow(
                "select price_pebbles, stock from public.agent_shops where agent_id = $1 and item_id = $2",
                seller_agent_id, item_id,
            )
            if not listing:
                return {"ok": False, "error": "Item not in shop"}
            if listing["stock"] == 0:
                return {"ok": False, "error": "Out of stock"}

            price = listing["price_pebbles"]

            # Check buyer balance
            wallet = await conn.fetchrow(
                "select pebbles from public.agent_wallets where agent_id = $1 for update",
                buyer_agent_id,
            )
            if not wallet or wallet["pebbles"] < price:
                return {"ok": False, "error": "Not enough pebbles"}

            # Get item info for stacking
            item = await conn.fetchrow(
                "select stackable, max_stack from public.item_catalog where id = $1",
                item_id,
            )

            # Find a slot — try stacking first if stackable
            slot_index = None
            if item["stackable"]:
                existing = await conn.fetchrow(
                    """select slot_index, quantity from public.agent_inventory
                       where agent_id = $1 and item_id = $2 and quantity < $3
                       order by slot_index limit 1""",
                    buyer_agent_id, item_id, item["max_stack"],
                )
                if existing:
                    slot_index = existing["slot_index"]
                    await conn.execute(
                        "update public.agent_inventory set quantity = quantity + 1 where agent_id = $1 and slot_index = $2",
                        buyer_agent_id, slot_index,
                    )

            if slot_index is None:
                # Find first empty slot
                occupied = await conn.fetch(
                    "select slot_index from public.agent_inventory where agent_id = $1 order by slot_index",
                    buyer_agent_id,
                )
                used = {r["slot_index"] for r in occupied}
                for i in range(48):
                    if i not in used:
                        slot_index = i
                        break
                if slot_index is None:
                    return {"ok": False, "error": "Inventory full"}
                await conn.execute(
                    "insert into public.agent_inventory (agent_id, slot_index, item_id, quantity) values ($1, $2, $3, 1)",
                    buyer_agent_id, slot_index, item_id,
                )

            # Deduct pebbles from buyer
            await conn.execute(
                "update public.agent_wallets set pebbles = pebbles - $2, updated_at = now() where agent_id = $1",
                buyer_agent_id, price,
            )
            # Add pebbles to seller
            await conn.execute(
                "update public.agent_wallets set pebbles = pebbles + $2, updated_at = now() where agent_id = $1",
                seller_agent_id, price,
            )
            # Decrement stock if limited
            if listing["stock"] > 0:
                await conn.execute(
                    "update public.agent_shops set stock = stock - 1 where agent_id = $1 and item_id = $2",
                    seller_agent_id, item_id,
                )
            # Log transaction
            await conn.execute(
                """insert into public.pebble_transactions
                   (from_agent_id, to_agent_id, amount, reason, item_id)
                   values ($1, $2, $3, 'shop_purchase', $4)""",
                buyer_agent_id, seller_agent_id, price, item_id,
            )

            new_balance = await conn.fetchval(
                "select pebbles from public.agent_wallets where agent_id = $1",
                buyer_agent_id,
            )

    return {"ok": True, "buyer_pebbles": new_balance, "slot_index": slot_index}


async def transfer_pebbles(
    from_agent_id: str,
    to_agent_id: str,
    amount: int,
    owner_user_id: str,
) -> dict:
    """Transfer pebbles between agents owned by the same user."""
    if amount <= 0:
        return {"ok": False, "error": "Amount must be positive"}
    async with acquire() as conn:
        async with conn.transaction():
            # Verify ownership
            for aid in (from_agent_id, to_agent_id):
                row = await conn.fetchrow(
                    "select id from public.agents where id = $1 and owner_user_id = $2",
                    aid, owner_user_id,
                )
                if not row:
                    return {"ok": False, "error": f"Agent {aid} not owned by you"}

            wallet = await conn.fetchrow(
                "select pebbles from public.agent_wallets where agent_id = $1 for update",
                from_agent_id,
            )
            if not wallet or wallet["pebbles"] < amount:
                return {"ok": False, "error": "Not enough pebbles"}

            await conn.execute(
                "update public.agent_wallets set pebbles = pebbles - $2, updated_at = now() where agent_id = $1",
                from_agent_id, amount,
            )
            await conn.execute(
                "update public.agent_wallets set pebbles = pebbles + $2, updated_at = now() where agent_id = $1",
                to_agent_id, amount,
            )
            await conn.execute(
                """insert into public.pebble_transactions
                   (from_agent_id, to_agent_id, amount, reason)
                   values ($1, $2, $3, 'transfer')""",
                from_agent_id, to_agent_id, amount,
            )

    return {"ok": True}


# ── Consistency checker ──────────────────────────────────────────────


async def validate_agent_inventory(agent_id: str) -> dict:
    """Validate a single agent's inventory integrity."""
    issues: list[str] = []
    async with acquire() as conn:
        # Check wallet exists and non-negative
        wallet = await conn.fetchrow(
            "select pebbles from public.agent_wallets where agent_id = $1",
            agent_id,
        )
        if not wallet:
            issues.append("No wallet found")
        elif wallet["pebbles"] < 0:
            issues.append(f"Negative pebble balance: {wallet['pebbles']}")

        # Check slot integrity
        slots = await conn.fetch(
            "select slot_index, item_id, quantity from public.agent_inventory where agent_id = $1",
            agent_id,
        )
        seen_slots: set[int] = set()
        for s in slots:
            idx = s["slot_index"]
            if idx < 0 or idx >= 48:
                issues.append(f"Slot {idx} out of bounds")
            if idx in seen_slots:
                issues.append(f"Duplicate slot {idx}")
            seen_slots.add(idx)
            if s["quantity"] < 1:
                issues.append(f"Slot {idx}: quantity < 1")

            # Check item exists and quantity within max_stack
            item = await conn.fetchrow(
                "select max_stack, stackable from public.item_catalog where id = $1",
                s["item_id"],
            )
            if not item:
                issues.append(f"Slot {idx}: item {s['item_id']} not in catalog")
            elif not item["stackable"] and s["quantity"] > 1:
                issues.append(f"Slot {idx}: non-stackable item has quantity {s['quantity']}")
            elif s["quantity"] > item["max_stack"]:
                issues.append(f"Slot {idx}: quantity {s['quantity']} exceeds max_stack {item['max_stack']}")

    return {"agent_id": agent_id, "valid": len(issues) == 0, "issues": issues}


async def validate_world_inventories(world_id: str) -> dict:
    """Recursively validate all agents' inventories in a world."""
    async with acquire() as conn:
        agents = await conn.fetch(
            "select id from public.agents where world_id = $1",
            world_id,
        )

    results = []
    total_pebbles = 0
    all_valid = True

    for agent in agents:
        aid = str(agent["id"])
        result = await validate_agent_inventory(aid)
        results.append(result)
        if not result["valid"]:
            all_valid = False

        wallet = await get_wallet(aid)
        total_pebbles += wallet["pebbles"]

    return {
        "world_id": world_id,
        "agents_checked": len(results),
        "all_valid": all_valid,
        "total_pebbles_in_circulation": total_pebbles,
        "agent_results": results,
    }
