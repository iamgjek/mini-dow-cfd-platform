import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable, Deque, List, Tuple

from . import config

logger = logging.getLogger("price_engine")


# Field layout confirmed by sampling the raw feed directly (see
# docs/trading-info-chart-spec.md P1-1 未解決問題): fields 15-19 are the 5
# bid price levels (best first, descending) with matching quantities at
# 20-24; 25-29/30-34 are the mirror image for asks (best first, ascending).
DEPTH_LEVELS = 5


@dataclass(frozen=True)
class Tick:
    ts: float
    mid: float
    bid: float
    ask: float
    bid_levels: Tuple[Tuple[float, float], ...] = ()
    ask_levels: Tuple[Tuple[float, float], ...] = ()


class PriceEngine:
    """Live quote client for a real TF-market TCP feed (see config.py).

    The feed is a firehose of every symbol on the market, one `{...}`-framed
    CSV record per line; this filters it down to the single configured
    instrument and re-exposes it as the same Tick/subscribe/history interface
    the rest of the app already expects, so the trading engine never has to
    know its prices come from a socket instead of a formula.
    """

    def __init__(self) -> None:
        self.symbol: str = config.TF_SYMBOL
        self.mid: float = 0.0
        self.bid: float = 0.0
        self.ask: float = 0.0
        self.bid_levels: Tuple[Tuple[float, float], ...] = ()
        self.ask_levels: Tuple[Tuple[float, float], ...] = ()
        self.history: Deque[Tuple[float, float]] = deque(maxlen=config.MAX_TICK_HISTORY)
        self._listeners: List[Callable[[Tick], None]] = []

    def subscribe(self, callback: Callable[[Tick], None]) -> None:
        self._listeners.append(callback)

    def unsubscribe(self, callback: Callable[[Tick], None]) -> None:
        if callback in self._listeners:
            self._listeners.remove(callback)

    def latest_tick(self) -> Tick:
        return Tick(
            ts=time.time(), mid=self.mid, bid=self.bid, ask=self.ask,
            bid_levels=self.bid_levels, ask_levels=self.ask_levels,
        )

    def set_symbol(self, new_symbol: str) -> None:
        """Switch which feed symbol this engine tracks (contract rollover).

        A different symbol is a different instrument's price series, so the
        stale mid/bid/ask and tick history are cleared rather than carried
        over — otherwise a chart/mark price would silently mix two
        different contracts' prices.
        """
        logger.info("switching tracked symbol: %s -> %s", self.symbol, new_symbol)
        self.symbol = new_symbol
        self.mid = 0.0
        self.bid = 0.0
        self.ask = 0.0
        self.bid_levels = ()
        self.ask_levels = ()
        self.history.clear()

    @staticmethod
    def _parse_levels(parts: list, price_start: int, qty_start: int) -> Tuple[Tuple[float, float], ...]:
        levels = []
        for i in range(DEPTH_LEVELS):
            try:
                price = float(parts[price_start + i])
                qty = float(parts[qty_start + i])
            except (ValueError, IndexError):
                price, qty = 0.0, 0.0
            levels.append((price, qty))
        return tuple(levels)

    def _connect_string(self) -> str:
        if not config.TF_USERNAME or not config.TF_PASSWORD:
            raise RuntimeError(
                "TF_USERNAME / TF_PASSWORD are not set. Set them to your quote "
                "feed credentials (see .env.example)."
            )
        return (
            f";uz=2;utf8=1;wt1=0;m={config.TF_MARKET};"
            f"u={config.TF_USERNAME};p={config.TF_PASSWORD};"
        )

    def _handle_line(self, line: str) -> None:
        inner = line.strip().strip("{}")
        if not inner:
            return
        parts = inner.split(",")
        # {header, time, code, name, ...29 quote fields..., footer} == 36 fields.
        if len(parts) < 36 or parts[0] == "A":
            return  # too short to be a quote row, or an "A,OK,..." info packet
        if parts[2] != self.symbol:
            return

        try:
            last = float(parts[12])
            bid = float(parts[15])
            ask = float(parts[25])
        except ValueError:
            return
        if last <= 0:
            return

        self.mid = last
        self.bid = bid if bid > 0 else last
        self.ask = ask if ask > 0 else last
        self.bid_levels = self._parse_levels(parts, price_start=15, qty_start=20)
        self.ask_levels = self._parse_levels(parts, price_start=25, qty_start=30)
        now = time.time()
        self.history.append((now, self.mid))

        tick = Tick(
            ts=now, mid=self.mid, bid=self.bid, ask=self.ask,
            bid_levels=self.bid_levels, ask_levels=self.ask_levels,
        )
        for listener in list(self._listeners):
            listener(tick)

    async def run(self) -> None:
        backoff = 1.0
        while True:
            writer = None
            try:
                # Recomputed every attempt (not hoisted above the loop) so a
                # missing/misconfigured credential just gets retried with
                # backoff forever instead of permanently killing this
                # fire-and-forget background task on the first failure.
                connect_str = self._connect_string().encode("utf-8")
                logger.info("connecting to feed %s:%s ...", config.TF_HOST, config.TF_PORT)
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection(config.TF_HOST, config.TF_PORT), timeout=10
                )
                writer.write(connect_str)
                await writer.drain()
                logger.info("feed connected, sent login string")
                backoff = 1.0
                last_heartbeat = time.time()
                lines_received = 0

                while True:
                    raw = await asyncio.wait_for(reader.readuntil(b"\n"), timeout=30)
                    lines_received += 1
                    if lines_received == 1:
                        logger.info("first line from feed: %r", raw[:200])
                    self._handle_line(raw.decode("utf-8", errors="replace"))

                    if time.time() - last_heartbeat > config.TF_HEARTBEAT_SECONDS:
                        writer.write(connect_str)
                        await writer.drain()
                        last_heartbeat = time.time()
            except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, RuntimeError) as exc:
                logger.warning("feed connection lost/failed: %s: %s", type(exc).__name__, exc)
            finally:
                if writer is not None:
                    writer.close()

            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)
