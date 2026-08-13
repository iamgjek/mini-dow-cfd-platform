"""Low-frequency durability net for price_engine's in-memory tick history.

price_engine.history is a deque that lives only in process memory — a
restart (deploy, crash, or just a dev server bounce) wipes it. If that
happens during a stretch with no live ticks (e.g. the 13:45-15:00 gap
between the day and night sessions), there's nothing to repopulate it and
the chart shows blank until new ticks arrive. This module periodically
persists a coarse (one-close-price-per-minute) copy to Postgres so
get_history() has something to backfill from after a restart.

Deliberately NOT done per-tick: price_engine._handle_line() calls every
listener synchronously on the feed's asyncio loop, so a blocking psycopg
write there would stall quotes for every connected user. A low-frequency
background loop keeps the write volume tiny and off that hot path. See
docs/trading-info-chart-spec.md P0-15.
"""

import asyncio
import logging
import time

from . import db
from .price_engine import PriceEngine

logger = logging.getLogger("history_store")

FLUSH_INTERVAL_SECONDS = 30
RETENTION_SECONDS = 48 * 3600


def _bucket_recent(history, since_ts: float) -> list[tuple[float, float]]:
    """Collapse the tail of `history` (a deque of (ts, price)) into one
    closing price per minute, for every minute touched since `since_ts`."""
    buckets: dict[float, float] = {}
    for ts, price in history:
        if ts < since_ts:
            continue
        bucket_ts = (ts // 60) * 60
        buckets[bucket_ts] = price  # last write per bucket wins — history is time-ordered
    return list(buckets.items())


def flush_recent(price_engine: PriceEngine) -> None:
    now = time.time()
    points = _bucket_recent(price_engine.history, now - FLUSH_INTERVAL_SECONDS - 60)
    if points:
        db.upsert_price_points(price_engine.symbol, points)
    db.prune_price_history(now - RETENTION_SECONDS)


async def run_history_flush_loop(price_engine: PriceEngine) -> None:
    while True:
        await asyncio.sleep(FLUSH_INTERVAL_SECONDS)
        try:
            flush_recent(price_engine)
        except Exception:
            logger.exception("price history flush failed")
