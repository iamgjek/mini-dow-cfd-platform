import asyncio
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable, Deque, List, Tuple

from . import config


@dataclass(frozen=True)
class Tick:
    ts: float
    mid: float
    bid: float
    ask: float


class PriceEngine:
    """Live quote client for a real TF-market TCP feed (see config.py).

    The feed is a firehose of every symbol on the market, one `{...}`-framed
    CSV record per line; this filters it down to the single configured
    instrument and re-exposes it as the same Tick/subscribe/history interface
    the rest of the app already expects, so the trading engine never has to
    know its prices come from a socket instead of a formula.
    """

    def __init__(self) -> None:
        self.mid: float = 0.0
        self.bid: float = 0.0
        self.ask: float = 0.0
        self.history: Deque[Tuple[float, float]] = deque(maxlen=config.MAX_TICK_HISTORY)
        self._listeners: List[Callable[[Tick], None]] = []

    def subscribe(self, callback: Callable[[Tick], None]) -> None:
        self._listeners.append(callback)

    def unsubscribe(self, callback: Callable[[Tick], None]) -> None:
        if callback in self._listeners:
            self._listeners.remove(callback)

    def latest_tick(self) -> Tick:
        return Tick(ts=time.time(), mid=self.mid, bid=self.bid, ask=self.ask)

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
        if parts[2] != config.TF_SYMBOL:
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
        now = time.time()
        self.history.append((now, self.mid))

        tick = Tick(ts=now, mid=self.mid, bid=self.bid, ask=self.ask)
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
                reader, writer = await asyncio.open_connection(config.TF_HOST, config.TF_PORT)
                writer.write(connect_str)
                await writer.drain()
                backoff = 1.0
                last_heartbeat = time.time()

                while True:
                    raw = await asyncio.wait_for(reader.readuntil(b"\n"), timeout=30)
                    self._handle_line(raw.decode("utf-8", errors="replace"))

                    if time.time() - last_heartbeat > config.TF_HEARTBEAT_SECONDS:
                        writer.write(connect_str)
                        await writer.drain()
                        last_heartbeat = time.time()
            except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, RuntimeError):
                pass
            finally:
                if writer is not None:
                    writer.close()

            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)
