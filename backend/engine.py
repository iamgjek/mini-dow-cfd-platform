import time
from typing import Callable, List, Optional

from . import config, db
from .models import Account, Order, OrderStatus, OrderType, Position, Side, Trade
from .price_engine import PriceEngine, Tick


class TradingEngine:
    """Per-user in-memory paper-trading engine, write-through persisted to SQLite.

    Netted single-position model (like a typical CFD account): buy/sell
    orders increase, reduce, close, or flip one net position. All fills,
    P&L, and margin are computed locally — no real money or broker involved.
    """

    def __init__(self, user_id: int, price_engine: PriceEngine) -> None:
        self.user_id = user_id
        self.price_engine = price_engine
        self._update_listeners: List[Callable[[str, object], None]] = []
        self._load_from_db()

    def _load_from_db(self) -> None:
        user_row = db.get_user_by_id(self.user_id)
        self.balance: float = user_row["balance"]

        pos_row = db.get_position(self.user_id)
        self.position = Position(
            qty=pos_row["qty"],
            avg_price=pos_row["avg_price"],
            stop_loss=pos_row["stop_loss"],
            take_profit=pos_row["take_profit"],
            opened_at=pos_row["opened_at"],
        )

        self.orders: List[Order] = [
            Order(
                id=r["id"], side=r["side"], order_type=r["order_type"], qty=r["qty"],
                limit_price=r["limit_price"], stop_loss=r["stop_loss"], take_profit=r["take_profit"],
                status=r["status"], reject_reason=r["reject_reason"], filled_price=r["filled_price"],
                filled_at=r["filled_at"], created_at=r["created_at"],
            )
            for r in db.list_orders(self.user_id)
        ]
        self.trades: List[Trade] = [
            Trade(id=r["id"], order_id=r["order_id"], side=r["side"], qty=r["qty"], price=r["price"],
                  realized_pnl=r["realized_pnl"], ts=r["ts"])
            for r in db.list_trades(self.user_id)
        ]

    def _save_position(self) -> None:
        p = self.position
        db.save_position(self.user_id, p.qty, p.avg_price, p.stop_loss, p.take_profit, p.opened_at)

    def _save_balance(self) -> None:
        db.save_balance(self.user_id, self.balance)

    def on_update(self, callback: Callable[[str, object], None]) -> None:
        self._update_listeners.append(callback)

    def _emit(self, kind: str, payload: object) -> None:
        for listener in list(self._update_listeners):
            listener(kind, payload)

    def _last_prices(self) -> Tick:
        return self.price_engine.latest_tick()

    def unrealized_pnl(self, price: float) -> float:
        if self.position.qty == 0:
            return 0.0
        return (price - self.position.avg_price) * self.position.qty * config.CONTRACT_MULTIPLIER

    def account_snapshot(self) -> Account:
        tick = self._last_prices()
        mark = tick.bid if self.position.qty > 0 else tick.ask if self.position.qty < 0 else tick.mid
        upnl = self.unrealized_pnl(mark)
        equity = self.balance + upnl
        used_margin = abs(self.position.qty) * mark * config.CONTRACT_MULTIPLIER * config.MARGIN_RATE
        return Account(
            balance=round(self.balance, 2),
            equity=round(equity, 2),
            used_margin=round(used_margin, 2),
            free_margin=round(equity - used_margin, 2),
            unrealized_pnl=round(upnl, 2),
        )

    def place_order(
        self,
        side: Side,
        order_type: OrderType,
        qty: float,
        limit_price: Optional[float] = None,
        stop_loss: Optional[float] = None,
        take_profit: Optional[float] = None,
    ) -> Order:
        if qty <= 0:
            raise ValueError("qty must be positive")
        if order_type == OrderType.LIMIT and limit_price is None:
            raise ValueError("limit_price is required for LIMIT orders")

        order = Order(
            side=side,
            order_type=order_type,
            qty=qty,
            limit_price=limit_price,
            stop_loss=stop_loss,
            take_profit=take_profit,
        )
        order.id = db.insert_order(self.user_id, order.model_dump(mode="json", exclude={"id"}))
        self.orders.insert(0, order)
        self._emit("order", order)

        tick = self._last_prices()
        if order_type == OrderType.MARKET:
            self._try_fill(order, tick.ask if side == Side.BUY else tick.bid)
        else:
            self._try_limit_fill(order, tick)
        return order

    def cancel_order(self, order_id: int) -> Order:
        order = self._find_order(order_id)
        if order.status != OrderStatus.PENDING:
            raise ValueError(f"order {order_id} is not pending (status={order.status})")
        order.status = OrderStatus.CANCELLED
        db.update_order(order.id, status=order.status.value)
        self._emit("order", order)
        return order

    def update_position_risk(self, stop_loss: Optional[float], take_profit: Optional[float]) -> Position:
        if self.position.qty == 0:
            raise ValueError("no open position")
        self.position.stop_loss = stop_loss
        self.position.take_profit = take_profit
        self._save_position()
        self._emit("position", self.position)
        return self.position

    def adjust_balance(self, amount: float) -> Account:
        self.balance += amount
        self._save_balance()
        snapshot = self.account_snapshot()
        self._emit("account", snapshot)
        return snapshot

    def close_position(self, qty: Optional[float] = None) -> Optional[Order]:
        if self.position.qty == 0:
            return None
        close_qty = abs(self.position.qty) if qty is None else min(qty, abs(self.position.qty))
        side = Side.SELL if self.position.qty > 0 else Side.BUY
        return self.place_order(side, OrderType.MARKET, close_qty)

    def _find_order(self, order_id: int) -> Order:
        for order in self.orders:
            if order.id == order_id:
                return order
        raise ValueError(f"order {order_id} not found")

    def _required_margin_after(self, prospective_qty: float, price: float) -> float:
        return abs(prospective_qty) * price * config.CONTRACT_MULTIPLIER * config.MARGIN_RATE

    def _try_fill(self, order: Order, price: float) -> None:
        # The live feed initializes bid/ask/mid at 0.0 until its first real
        # quote arrives; filling here before then would silently corrupt the
        # position's avg_price to 0 (and, for a closing fill, misprice the
        # realized P&L) rather than actually trading at a real price.
        if price <= 0:
            order.status = OrderStatus.REJECTED
            order.reject_reason = "quote not ready"
            db.update_order(order.id, status=order.status.value, reject_reason=order.reject_reason)
            self._emit("order", order)
            return

        signed_qty = order.qty if order.side == Side.BUY else -order.qty
        prospective_qty = self.position.qty + signed_qty

        increasing_exposure = abs(prospective_qty) > abs(self.position.qty)
        if increasing_exposure:
            equity = self.balance + self.unrealized_pnl(price)
            required = self._required_margin_after(prospective_qty, price)
            if required > equity:
                order.status = OrderStatus.REJECTED
                order.reject_reason = "insufficient margin"
                db.update_order(order.id, status=order.status.value, reject_reason=order.reject_reason)
                self._emit("order", order)
                return

        realized = self._apply_fill(signed_qty, price)
        order.status = OrderStatus.FILLED
        order.filled_price = price
        order.filled_at = time.time()
        if order.stop_loss is not None or order.take_profit is not None:
            self.position.stop_loss = order.stop_loss
            self.position.take_profit = order.take_profit

        db.update_order(
            order.id, status=order.status.value, filled_price=order.filled_price, filled_at=order.filled_at
        )
        self._save_position()
        self._save_balance()

        trade = Trade(order_id=order.id, side=order.side, qty=order.qty, price=price, realized_pnl=realized)
        trade.id = db.insert_trade(self.user_id, order.id, order.side.value, order.qty, price, realized)
        self.trades.insert(0, trade)

        self._emit("order", order)
        self._emit("trade", trade)
        self._emit("position", self.position)
        self._emit("account", self.account_snapshot())

    def _try_limit_fill(self, order: Order, tick: Tick) -> None:
        if order.side == Side.BUY and tick.ask <= order.limit_price:
            self._try_fill(order, order.limit_price)
        elif order.side == Side.SELL and tick.bid >= order.limit_price:
            self._try_fill(order, order.limit_price)

    def _apply_fill(self, signed_qty: float, price: float) -> float:
        pos = self.position
        realized = 0.0
        if pos.qty == 0 or (pos.qty > 0) == (signed_qty > 0):
            new_qty = pos.qty + signed_qty
            if pos.qty == 0:
                pos.avg_price = price
                pos.opened_at = time.time()
            else:
                pos.avg_price = (abs(pos.qty) * pos.avg_price + abs(signed_qty) * price) / abs(new_qty)
            pos.qty = new_qty
        else:
            closing_qty = min(abs(pos.qty), abs(signed_qty))
            direction = 1 if pos.qty > 0 else -1
            realized = (price - pos.avg_price) * closing_qty * direction * config.CONTRACT_MULTIPLIER
            self.balance += realized
            remaining_signed = pos.qty + signed_qty
            if abs(signed_qty) > abs(pos.qty):
                pos.qty = remaining_signed
                pos.avg_price = price
                pos.opened_at = time.time()
            else:
                pos.qty = remaining_signed
                if pos.qty == 0:
                    pos.avg_price = 0.0
                    pos.stop_loss = None
                    pos.take_profit = None
                    pos.opened_at = None
        return realized

    def on_tick(self, tick: Tick) -> None:
        for order in self.orders:
            if order.status == OrderStatus.PENDING and order.order_type == OrderType.LIMIT:
                self._try_limit_fill(order, tick)

        if self.position.qty != 0:
            mark = tick.bid if self.position.qty > 0 else tick.ask
            sl, tp = self.position.stop_loss, self.position.take_profit
            hit_sl = sl is not None and (
                (self.position.qty > 0 and mark <= sl) or (self.position.qty < 0 and mark >= sl)
            )
            hit_tp = tp is not None and (
                (self.position.qty > 0 and mark >= tp) or (self.position.qty < 0 and mark <= tp)
            )
            if hit_sl or hit_tp:
                self.close_position()

        self._emit("tick", tick)
        self._emit("account", self.account_snapshot())
