import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import Depends, FastAPI, HTTPException, Response, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth, config, db, history_store, rollover
from .engine_manager import EngineManager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
from .models import (
    AdjustBalanceRequest,
    CreateUserRequest,
    LoginRequest,
    Order,
    OrderType,
    RegisterRequest,
    SetRoleRequest,
    Side,
    UpdateSettingsRequest,
    UpdateUserRequest,
)
from .price_engine import PriceEngine, Tick

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

price_engine = PriceEngine()

_ws_clients: Dict[int, List[WebSocket]] = {}
_main_loop: Optional[asyncio.AbstractEventLoop] = None


def _serialize(payload: object):
    if isinstance(payload, Tick):
        return {
            "ts": payload.ts, "mid": payload.mid, "bid": payload.bid, "ask": payload.ask,
            "bid_levels": [list(level) for level in payload.bid_levels],
            "ask_levels": [list(level) for level in payload.ask_levels],
        }
    if isinstance(payload, BaseModel):
        return json.loads(payload.model_dump_json())
    return payload


def _broadcast_to_user(user_id: int, kind: str, payload: object) -> None:
    clients = _ws_clients.get(user_id)
    if not clients or _main_loop is None:
        return
    message = json.dumps({"type": kind, "data": _serialize(payload)}, default=str)
    for ws in list(clients):
        asyncio.run_coroutine_threadsafe(_safe_send(ws, message), _main_loop)


def _broadcast_to_all(kind: str, payload: object) -> None:
    if _main_loop is None:
        return
    message = json.dumps({"type": kind, "data": _serialize(payload)}, default=str)
    for clients in list(_ws_clients.values()):
        for ws in list(clients):
            asyncio.run_coroutine_threadsafe(_safe_send(ws, message), _main_loop)


async def _safe_send(ws: WebSocket, message: str) -> None:
    try:
        await ws.send_text(message)
    except Exception:
        pass


engine_manager = EngineManager(price_engine, _broadcast_to_user)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _main_loop
    db.init_db()
    _main_loop = asyncio.get_event_loop()
    feed_task = asyncio.create_task(price_engine.run())
    rollover_task = asyncio.create_task(rollover.run_rollover_loop(engine_manager, price_engine, _broadcast_to_all))
    history_task = asyncio.create_task(history_store.run_history_flush_loop(price_engine))
    yield
    feed_task.cancel()
    rollover_task.cancel()
    history_task.cancel()


app = FastAPI(title="Micro TAIEX (微小台指) Paper Trading Platform", lifespan=lifespan)


def user_to_dict(row: dict) -> dict:
    return {
        "id": row["id"],
        "email": row["email"],
        "display_name": row["display_name"],
        "role": row["role"],
        "is_active": bool(row["is_active"]),
    }


# --- auth --------------------------------------------------------------------

@app.post("/api/auth/register", status_code=201)
def register(req: RegisterRequest, response: Response):
    email = req.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="invalid email")
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="password must be at least 6 characters")
    if not req.display_name.strip():
        raise HTTPException(status_code=400, detail="display name required")
    if db.get_user_by_email(email) is not None:
        raise HTTPException(status_code=409, detail="email already registered")

    role = "admin" if db.count_users() == 0 else "user"
    initial_balance = float(db.get_setting("initial_balance", str(config.INITIAL_BALANCE)))
    password_hash, salt = auth.hash_password(req.password)
    user = db.create_user(email, password_hash, salt, req.display_name.strip(), role, initial_balance)

    token = auth.issue_session(user["id"])
    response.set_cookie(auth.SESSION_COOKIE, token, httponly=True, samesite="lax", max_age=auth.SESSION_TTL_SECONDS)
    return user_to_dict(user)


@app.post("/api/auth/login")
def login(req: LoginRequest, response: Response):
    email = req.email.strip().lower()
    user = db.get_user_by_email(email)
    if user is None or not auth.verify_password(req.password, user["password_hash"], user["salt"]):
        raise HTTPException(status_code=401, detail="invalid email or password")
    if not user["is_active"]:
        raise HTTPException(status_code=403, detail="account disabled")

    token = auth.issue_session(user["id"])
    response.set_cookie(auth.SESSION_COOKIE, token, httponly=True, samesite="lax", max_age=auth.SESSION_TTL_SECONDS)
    return user_to_dict(user)


@app.post("/api/auth/logout")
def logout(response: Response, request_token: Optional[str] = Depends(auth.get_token_from_request)):
    if request_token:
        db.delete_session(request_token)
    response.delete_cookie(auth.SESSION_COOKIE)
    return {"ok": True}


@app.get("/api/auth/me")
def me(user: dict = Depends(auth.get_current_user)):
    return user_to_dict(user)


# --- trading (scoped to the authenticated user) --------------------------------

class PlaceOrderRequest(BaseModel):
    side: Side
    order_type: OrderType
    qty: float
    limit_price: Optional[float] = None
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None


class RiskRequest(BaseModel):
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None


class ClosePositionRequest(BaseModel):
    qty: Optional[float] = None


@app.get("/api/instrument")
def get_instrument():
    return {
        "symbol": price_engine.symbol,
        "name": config.INSTRUMENT_NAME,
        "tick_size": config.TICK_SIZE,
        "multiplier": config.CONTRACT_MULTIPLIER,
        "margin_rate": config.MARGIN_RATE,
    }


# If the in-memory deque doesn't reach back this far, it's treated as
# "thin" (e.g. right after a restart) and backfilled from price_history —
# see docs/trading-info-chart-spec.md P0-16.
HISTORY_BACKFILL_THRESHOLD_SECONDS = 3600
HISTORY_BACKFILL_WINDOW_SECONDS = 48 * 3600


@app.get("/api/history")
def get_history():
    memory_points = [{"ts": ts, "price": price} for ts, price in price_engine.history]
    now = time.time()
    earliest = memory_points[0]["ts"] if memory_points else now
    # How far back in-memory history actually reaches. Large enough already
    # (deque has been accumulating a while) → no need to hit the DB at all.
    if now - earliest >= HISTORY_BACKFILL_THRESHOLD_SECONDS:
        return memory_points

    db_rows = db.get_price_history(price_engine.symbol, now - HISTORY_BACKFILL_WINDOW_SECONDS)
    db_points = [{"ts": row["bucket_ts"], "price": row["price"]} for row in db_rows if row["bucket_ts"] < earliest]
    return db_points + memory_points


@app.get("/api/account")
def get_account(user: dict = Depends(auth.get_current_user)):
    return engine_manager.get(user["id"]).account_snapshot()


@app.get("/api/position")
def get_position(user: dict = Depends(auth.get_current_user)):
    return engine_manager.get(user["id"]).position


@app.get("/api/orders")
def list_orders(user: dict = Depends(auth.get_current_user)):
    return engine_manager.get(user["id"]).orders


@app.post("/api/orders", status_code=201)
def place_order(req: PlaceOrderRequest, user: dict = Depends(auth.get_current_user)):
    engine = engine_manager.get(user["id"])
    try:
        order: Order = engine.place_order(
            side=req.side,
            order_type=req.order_type,
            qty=req.qty,
            limit_price=req.limit_price,
            stop_loss=req.stop_loss,
            take_profit=req.take_profit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return order


@app.delete("/api/orders/{order_id}")
def cancel_order(order_id: int, user: dict = Depends(auth.get_current_user)):
    engine = engine_manager.get(user["id"])
    try:
        return engine.cancel_order(order_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/position/close")
def close_position(req: ClosePositionRequest, user: dict = Depends(auth.get_current_user)):
    engine = engine_manager.get(user["id"])
    order = engine.close_position(qty=req.qty)
    if order is None:
        raise HTTPException(status_code=400, detail="no open position")
    return order


@app.put("/api/position/risk")
def update_risk(req: RiskRequest, user: dict = Depends(auth.get_current_user)):
    engine = engine_manager.get(user["id"])
    try:
        return engine.update_position_risk(req.stop_loss, req.take_profit)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/trades")
def list_trades(user: dict = Depends(auth.get_current_user)):
    return engine_manager.get(user["id"]).trades


# --- admin ---------------------------------------------------------------------

@app.get("/api/admin/stats")
def admin_stats(admin: dict = Depends(auth.require_admin)):
    return db.platform_stats()


@app.get("/api/admin/settings")
def admin_get_settings(admin: dict = Depends(auth.require_admin)):
    return {"initial_balance": float(db.get_setting("initial_balance", str(config.INITIAL_BALANCE)))}


@app.put("/api/admin/settings")
def admin_update_settings(req: UpdateSettingsRequest, admin: dict = Depends(auth.require_admin)):
    if req.initial_balance <= 0:
        raise HTTPException(status_code=400, detail="initial_balance must be positive")
    db.set_setting("initial_balance", str(req.initial_balance))
    return {"initial_balance": req.initial_balance}


@app.get("/api/admin/users")
def admin_list_users(admin: dict = Depends(auth.require_admin)):
    result = []
    for row in db.list_users():
        engine = engine_manager.get(row["id"])
        account = engine.account_snapshot()
        result.append({**user_to_dict(row), "account": json.loads(account.model_dump_json()), "position_qty": engine.position.qty})
    return result


@app.post("/api/admin/users", status_code=201)
def admin_create_user(req: CreateUserRequest, admin: dict = Depends(auth.require_admin)):
    email = req.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="invalid email")
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="password must be at least 6 characters")
    if not req.display_name.strip():
        raise HTTPException(status_code=400, detail="display name required")
    if db.get_user_by_email(email) is not None:
        raise HTTPException(status_code=409, detail="email already registered")
    if req.initial_balance is not None and req.initial_balance < 0:
        raise HTTPException(status_code=400, detail="initial_balance cannot be negative")

    balance = req.initial_balance if req.initial_balance is not None else float(
        db.get_setting("initial_balance", str(config.INITIAL_BALANCE))
    )
    password_hash, salt = auth.hash_password(req.password)
    user = db.create_user(email, password_hash, salt, req.display_name.strip(), req.role, balance)
    return user_to_dict(user)


@app.get("/api/admin/users/{user_id}")
def admin_user_detail(user_id: int, admin: dict = Depends(auth.require_admin)):
    row = db.get_user_by_id(user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="user not found")
    engine = engine_manager.get(user_id)
    return {
        "user": user_to_dict(row),
        "account": engine.account_snapshot(),
        "position": engine.position,
        "orders": engine.orders[:50],
        "trades": engine.trades[:50],
    }


@app.put("/api/admin/users/{user_id}")
def admin_update_user(user_id: int, req: UpdateUserRequest, admin: dict = Depends(auth.require_admin)):
    row = db.get_user_by_id(user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="user not found")

    display_name = req.display_name.strip() if req.display_name is not None else row["display_name"]
    email = req.email.strip().lower() if req.email is not None else row["email"]
    if not display_name:
        raise HTTPException(status_code=400, detail="display name required")
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="invalid email")
    existing = db.get_user_by_email(email)
    if existing is not None and existing["id"] != user_id:
        raise HTTPException(status_code=409, detail="email already registered")
    db.update_user_profile(user_id, display_name, email)

    if req.password:
        if len(req.password) < 6:
            raise HTTPException(status_code=400, detail="password must be at least 6 characters")
        password_hash, salt = auth.hash_password(req.password)
        db.update_user_password(user_id, password_hash, salt)

    return user_to_dict(db.get_user_by_id(user_id))


@app.post("/api/admin/users/{user_id}/adjust-balance")
def admin_adjust_balance(user_id: int, req: AdjustBalanceRequest, admin: dict = Depends(auth.require_admin)):
    row = db.get_user_by_id(user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="user not found")
    engine = engine_manager.get(user_id)
    snapshot = engine.adjust_balance(req.amount)
    db.record_balance_adjustment(user_id, req.amount, req.reason or "", admin["id"])
    return snapshot


@app.post("/api/admin/users/{user_id}/toggle-active")
def admin_toggle_active(user_id: int, admin: dict = Depends(auth.require_admin)):
    row = db.get_user_by_id(user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="user not found")
    if row["id"] == admin["id"]:
        raise HTTPException(status_code=400, detail="cannot disable your own account")
    db.set_user_active(user_id, not row["is_active"])
    return user_to_dict(db.get_user_by_id(user_id))


@app.post("/api/admin/users/{user_id}/set-role")
def admin_set_role(user_id: int, req: SetRoleRequest, admin: dict = Depends(auth.require_admin)):
    row = db.get_user_by_id(user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="user not found")
    if row["id"] == admin["id"]:
        raise HTTPException(status_code=400, detail="cannot change your own role")
    if row["role"] == "admin" and req.role == "user" and db.count_admins() <= 1:
        raise HTTPException(status_code=400, detail="cannot demote the last remaining admin")
    db.set_user_role(user_id, req.role)
    return user_to_dict(db.get_user_by_id(user_id))


# --- websocket -------------------------------------------------------------------

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    user = auth.user_from_ws_cookie(ws.headers.get("cookie"))
    if user is None:
        await ws.close(code=4401)
        return

    await ws.accept()
    user_id = user["id"]
    _ws_clients.setdefault(user_id, []).append(ws)

    engine = engine_manager.get(user_id)
    snapshot = {
        "type": "snapshot",
        "data": {
            "instrument": get_instrument(),
            "tick": _serialize(price_engine.latest_tick()),
            "history": get_history(),
            "account": _serialize(engine.account_snapshot()),
            "position": _serialize(engine.position),
            "orders": [_serialize(o) for o in engine.orders],
            "trades": [_serialize(t) for t in engine.trades],
        },
    }
    await ws.send_text(json.dumps(snapshot, default=str))
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        clients = _ws_clients.get(user_id)
        if clients and ws in clients:
            clients.remove(ws)


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
