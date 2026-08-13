"""Monthly futures contract rollover: force-flatten every open position and
switch the tracked feed symbol to the next month's contract.

See contract_calendar.py for the calendar rule this follows. This module
owns the *live* side of it — the async loop that fires while the process is
running — whereas config.py's TF_SYMBOL default only covers what happens at
process startup. Both are needed: this is a long-lived server, so a
calendar boundary can pass while it's running without ever restarting.
"""

import asyncio
import datetime as dt
import logging
from typing import Callable

from . import config, db
from .contract_calendar import TAIPEI, next_rollover_trigger, symbol_for
from .engine_manager import EngineManager
from .models import OrderStatus
from .price_engine import PriceEngine

logger = logging.getLogger("rollover")

# A rejected force-close (e.g. the feed hiccupping right at the trigger
# instant) gets a few retries with a short pause before we give up and just
# log it loudly — leaving a stuck position is worse than a slightly late one.
MAX_CLOSE_ATTEMPTS = 3
RETRY_DELAY_SECONDS = 2


async def _force_close_all(engine_manager: EngineManager) -> tuple[int, list]:
    user_ids = db.user_ids_with_open_position()
    ok_count = 0
    failed: list = []
    for user_id in user_ids:
        engine = engine_manager.get(user_id)
        closed = False
        for attempt in range(1, MAX_CLOSE_ATTEMPTS + 1):
            if engine.position.qty == 0:
                closed = True
                break
            order = engine.close_position()
            if order is not None and order.status == OrderStatus.FILLED:
                closed = True
                break
            reason = order.reject_reason if order is not None else "no order returned"
            logger.warning(
                "rollover force-close attempt %d/%d for user %s did not fill: %s",
                attempt, MAX_CLOSE_ATTEMPTS, user_id, reason,
            )
            if attempt < MAX_CLOSE_ATTEMPTS:
                await asyncio.sleep(RETRY_DELAY_SECONDS)
        if closed:
            ok_count += 1
        else:
            failed.append(user_id)
    return ok_count, failed


async def perform_rollover(
    engine_manager: EngineManager,
    price_engine: PriceEngine,
    broadcast_all: Callable[[str, dict], None],
    now: dt.datetime = None,
) -> None:
    """`now` defaults to the real current time; overridable for tests."""
    old_symbol = price_engine.symbol
    new_symbol = symbol_for((now or dt.datetime.now(TAIPEI)).date())
    if new_symbol == old_symbol:
        logger.warning("rollover triggered but target symbol is unchanged (%s) — skipping", old_symbol)
        return

    closed_count, failed = await _force_close_all(engine_manager)

    # Switch feed symbols only *after* force-closing everyone, so those
    # closes still price against the (still-live) expiring contract.
    price_engine.set_symbol(new_symbol)

    if failed:
        logger.error(
            "contract rollover %s -> %s: %d position(s) closed, %d FAILED to close (user_ids=%s) — needs manual attention",
            old_symbol, new_symbol, closed_count, len(failed), failed,
        )
    else:
        logger.info(
            "contract rollover complete: %s -> %s (%d position(s) force-closed)",
            old_symbol, new_symbol, closed_count,
        )

    broadcast_all(
        "instrument",
        {
            "symbol": price_engine.symbol,
            "name": config.INSTRUMENT_NAME,
            "tick_size": config.TICK_SIZE,
            "multiplier": config.CONTRACT_MULTIPLIER,
            "margin_rate": config.MARGIN_RATE,
        },
    )


async def run_rollover_loop(
    engine_manager: EngineManager,
    price_engine: PriceEngine,
    broadcast_all: Callable[[str, dict], None],
) -> None:
    while True:
        now = dt.datetime.now(TAIPEI)
        trigger = next_rollover_trigger(now)
        wait_seconds = (trigger - now).total_seconds()
        logger.info("next contract rollover scheduled for %s (in %.1f hours)", trigger.isoformat(), wait_seconds / 3600)
        await asyncio.sleep(wait_seconds)
        try:
            await perform_rollover(engine_manager, price_engine, broadcast_all)
        except Exception:
            logger.exception("contract rollover failed")
            # Don't spin if something is persistently broken (e.g. DB down);
            # next loop iteration will recompute the trigger and just try
            # again on the next occurrence rather than hammering retries.
            await asyncio.sleep(60)
