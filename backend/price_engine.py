import asyncio
import math
import random
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
    """Generates a synthetic random-walk price series for the demo instrument.

    Uses a discretized geometric Brownian motion so the walk stays positive
    and volatility scales sensibly with the reference price, purely for a
    realistic-looking simulation — not derived from any real market feed.
    """

    def __init__(self) -> None:
        self.mid: float = config.REFERENCE_PRICE
        self.history: Deque[Tuple[float, float]] = deque(maxlen=config.MAX_TICK_HISTORY)
        self.history.append((time.time(), self.mid))
        self._listeners: List[Callable[[Tick], None]] = []
        self._dt_years = config.TICK_INTERVAL_SECONDS / (365 * 24 * 60 * 60)
        self._sigma = config.ANNUAL_VOLATILITY

    def subscribe(self, callback: Callable[[Tick], None]) -> None:
        self._listeners.append(callback)

    def unsubscribe(self, callback: Callable[[Tick], None]) -> None:
        if callback in self._listeners:
            self._listeners.remove(callback)

    def latest_tick(self) -> Tick:
        half_spread = config.SPREAD / 2
        return Tick(
            ts=time.time(),
            mid=self.mid,
            bid=round(self.mid - half_spread, 2),
            ask=round(self.mid + half_spread, 2),
        )

    def _step(self) -> None:
        drift = 0.0
        shock = self._sigma * math.sqrt(self._dt_years) * random.gauss(0, 1)
        self.mid *= math.exp(drift - 0.5 * self._sigma ** 2 * self._dt_years + shock)
        self.mid = round(self.mid / config.TICK_SIZE) * config.TICK_SIZE
        self.history.append((time.time(), self.mid))

    async def run(self) -> None:
        while True:
            await asyncio.sleep(config.TICK_INTERVAL_SECONDS)
            self._step()
            tick = self.latest_tick()
            for listener in list(self._listeners):
                listener(tick)
