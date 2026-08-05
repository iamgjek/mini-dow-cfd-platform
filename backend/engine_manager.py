from typing import Callable, Dict

from .engine import TradingEngine
from .price_engine import PriceEngine, Tick


class EngineManager:
    """Owns one TradingEngine per user_id and fans out price ticks to all of them."""

    def __init__(self, price_engine: PriceEngine, on_engine_update: Callable[[int, str, object], None]) -> None:
        self.price_engine = price_engine
        self.on_engine_update = on_engine_update
        self._engines: Dict[int, TradingEngine] = {}
        self.price_engine.subscribe(self._on_tick)

    def get(self, user_id: int) -> TradingEngine:
        engine = self._engines.get(user_id)
        if engine is None:
            engine = TradingEngine(user_id, self.price_engine)
            engine.on_update(lambda kind, payload, uid=user_id: self.on_engine_update(uid, kind, payload))
            self._engines[user_id] = engine
        return engine

    def is_loaded(self, user_id: int) -> bool:
        return user_id in self._engines

    def _on_tick(self, tick: Tick) -> None:
        for engine in list(self._engines.values()):
            engine.on_tick(tick)
