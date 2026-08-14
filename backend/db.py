import os
import time
from typing import Any, Optional

import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row

load_dotenv()

_conn: Optional[psycopg.Connection] = None


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not set. Set it to your Supabase Postgres connection "
            "string (see .env.example)."
        )
    return url


def get_conn() -> psycopg.Connection:
    global _conn
    if _conn is None or _conn.closed:
        _conn = psycopg.connect(_database_url(), row_factory=dict_row, autocommit=True)
    return _conn


def _execute(query: str, params: tuple = ()) -> psycopg.Cursor:
    """Run a statement, transparently reconnecting once if the pooled
    connection was dropped (Supabase's pooler recycles idle connections)."""
    conn = get_conn()
    try:
        return conn.execute(query, params)
    except psycopg.OperationalError:
        global _conn
        _conn = None
        return get_conn().execute(query, params)


SCHEMA_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS users (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        balance DOUBLE PRECISION NOT NULL DEFAULT 100000,
        created_at DOUBLE PRECISION NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at DOUBLE PRECISION NOT NULL,
        expires_at DOUBLE PRECISION NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS positions (
        user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        qty DOUBLE PRECISION NOT NULL DEFAULT 0,
        avg_price DOUBLE PRECISION NOT NULL DEFAULT 0,
        stop_loss DOUBLE PRECISION,
        take_profit DOUBLE PRECISION,
        opened_at DOUBLE PRECISION
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS orders (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        side TEXT NOT NULL,
        order_type TEXT NOT NULL,
        qty DOUBLE PRECISION NOT NULL,
        limit_price DOUBLE PRECISION,
        stop_loss DOUBLE PRECISION,
        take_profit DOUBLE PRECISION,
        status TEXT NOT NULL,
        reject_reason TEXT,
        filled_price DOUBLE PRECISION,
        filled_at DOUBLE PRECISION,
        created_at DOUBLE PRECISION NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id)",
    """
    CREATE TABLE IF NOT EXISTS trades (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        order_id BIGINT NOT NULL,
        side TEXT NOT NULL,
        qty DOUBLE PRECISION NOT NULL,
        price DOUBLE PRECISION NOT NULL,
        realized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
        ts DOUBLE PRECISION NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id)",
    """
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS balance_adjustments (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount DOUBLE PRECISION NOT NULL,
        reason TEXT,
        admin_id BIGINT,
        ts DOUBLE PRECISION NOT NULL
    )
    """,
    # One row per (symbol, minute) — a low-frequency durability net for the
    # in-memory price_engine.history deque, not a tick-level archive. See
    # docs/trading-info-chart-spec.md P0-14.
    """
    CREATE TABLE IF NOT EXISTS price_history (
        symbol TEXT NOT NULL,
        bucket_ts DOUBLE PRECISION NOT NULL,
        price DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (symbol, bucket_ts)
    )
    """,
]


def init_db() -> None:
    conn = get_conn()
    for stmt in SCHEMA_STATEMENTS:
        conn.execute(stmt)


# --- settings ----------------------------------------------------------------

def get_setting(key: str, default: str) -> str:
    row = _execute("SELECT value FROM settings WHERE key = %s", (key,)).fetchone()
    return row["value"] if row is not None else default


def set_setting(key: str, value: str) -> None:
    _execute(
        "INSERT INTO settings (key, value) VALUES (%s, %s) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        (key, value),
    )


# --- users -----------------------------------------------------------------

def count_users() -> int:
    return _execute("SELECT COUNT(*) c FROM users").fetchone()["c"]


def create_user(email: str, password_hash: str, salt: str, display_name: str, role: str, balance: float) -> dict:
    row = _execute(
        "INSERT INTO users (email, password_hash, salt, display_name, role, balance, created_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
        (email, password_hash, salt, display_name, role, balance, time.time()),
    ).fetchone()
    user_id = row["id"]
    _execute("INSERT INTO positions (user_id, qty, avg_price) VALUES (%s, 0, 0)", (user_id,))
    return get_user_by_id(user_id)


def get_user_by_email(email: str) -> Optional[dict]:
    return _execute("SELECT * FROM users WHERE email = %s", (email,)).fetchone()


def get_user_by_id(user_id: int) -> Optional[dict]:
    return _execute("SELECT * FROM users WHERE id = %s", (user_id,)).fetchone()


def list_users() -> list[dict]:
    return _execute("SELECT * FROM users ORDER BY created_at").fetchall()


def set_user_active(user_id: int, is_active: bool) -> None:
    _execute("UPDATE users SET is_active = %s WHERE id = %s", (is_active, user_id))


def set_user_role(user_id: int, role: str) -> None:
    _execute("UPDATE users SET role = %s WHERE id = %s", (role, user_id))


def update_user_profile(user_id: int, display_name: str, email: str) -> None:
    _execute("UPDATE users SET display_name = %s, email = %s WHERE id = %s", (display_name, email, user_id))


def update_user_password(user_id: int, password_hash: str, salt: str) -> None:
    _execute("UPDATE users SET password_hash = %s, salt = %s WHERE id = %s", (password_hash, salt, user_id))


def count_admins() -> int:
    return _execute("SELECT COUNT(*) c FROM users WHERE role = 'admin'").fetchone()["c"]


def save_balance(user_id: int, balance: float) -> None:
    _execute("UPDATE users SET balance = %s WHERE id = %s", (balance, user_id))


def record_balance_adjustment(user_id: int, amount: float, reason: str, admin_id: int) -> None:
    _execute(
        "INSERT INTO balance_adjustments (user_id, amount, reason, admin_id, ts) VALUES (%s, %s, %s, %s, %s)",
        (user_id, amount, reason, admin_id, time.time()),
    )


# --- sessions ----------------------------------------------------------------

def create_session(token: str, user_id: int, ttl_seconds: int) -> None:
    now = time.time()
    _execute(
        "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (%s, %s, %s, %s)",
        (token, user_id, now, now + ttl_seconds),
    )


def get_session_user(token: str) -> Optional[dict]:
    return _execute(
        "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id "
        "WHERE sessions.token = %s AND sessions.expires_at > %s",
        (token, time.time()),
    ).fetchone()


def delete_session(token: str) -> None:
    _execute("DELETE FROM sessions WHERE token = %s", (token,))


# --- positions -----------------------------------------------------------------

def get_position(user_id: int) -> dict:
    row = _execute("SELECT * FROM positions WHERE user_id = %s", (user_id,)).fetchone()
    if row is None:
        _execute("INSERT INTO positions (user_id, qty, avg_price) VALUES (%s, 0, 0)", (user_id,))
        row = _execute("SELECT * FROM positions WHERE user_id = %s", (user_id,)).fetchone()
    return row


def save_position(user_id: int, qty: float, avg_price: float, stop_loss: Optional[float], take_profit: Optional[float], opened_at: Optional[float]) -> None:
    _execute(
        "UPDATE positions SET qty=%s, avg_price=%s, stop_loss=%s, take_profit=%s, opened_at=%s WHERE user_id=%s",
        (qty, avg_price, stop_loss, take_profit, opened_at, user_id),
    )


def user_ids_with_open_position() -> list:
    rows = _execute("SELECT user_id FROM positions WHERE qty != 0").fetchall()
    return [r["user_id"] for r in rows]


# --- orders / trades -----------------------------------------------------------

def insert_order(user_id: int, order: dict[str, Any]) -> int:
    row = _execute(
        "INSERT INTO orders (user_id, side, order_type, qty, limit_price, stop_loss, take_profit, status, "
        "reject_reason, filled_price, filled_at, created_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
        "RETURNING id",
        (
            user_id, order["side"], order["order_type"], order["qty"], order["limit_price"],
            order["stop_loss"], order["take_profit"], order["status"], order["reject_reason"],
            order["filled_price"], order["filled_at"], order["created_at"],
        ),
    ).fetchone()
    return row["id"]


def update_order(order_id: int, **fields: Any) -> None:
    if not fields:
        return
    cols = ", ".join(f"{k} = %s" for k in fields)
    _execute(f"UPDATE orders SET {cols} WHERE id = %s", (*fields.values(), order_id))


def list_orders(user_id: int, limit: int = 100) -> list[dict]:
    return _execute(
        "SELECT * FROM orders WHERE user_id = %s ORDER BY id DESC LIMIT %s", (user_id, limit)
    ).fetchall()


def insert_trade(user_id: int, order_id: int, side: str, qty: float, price: float, realized_pnl: float) -> int:
    row = _execute(
        "INSERT INTO trades (user_id, order_id, side, qty, price, realized_pnl, ts) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
        (user_id, order_id, side, qty, price, realized_pnl, time.time()),
    ).fetchone()
    return row["id"]


def list_trades(user_id: int, limit: int = 100) -> list[dict]:
    return _execute(
        "SELECT * FROM trades WHERE user_id = %s ORDER BY id DESC LIMIT %s", (user_id, limit)
    ).fetchall()


# --- price history (durability net for price_engine.history) ----------------

def upsert_price_points(symbol: str, points: list[tuple[float, float]]) -> None:
    """`points` is a small batch — the last minute or two, not the full
    history — so a plain per-row loop is fine here; this runs off the live
    quote path on a low-frequency background timer (see history_store.py),
    never per-tick."""
    for bucket_ts, price in points:
        _execute(
            "INSERT INTO price_history (symbol, bucket_ts, price) VALUES (%s, %s, %s) "
            "ON CONFLICT (symbol, bucket_ts) DO UPDATE SET price = EXCLUDED.price",
            (symbol, bucket_ts, price),
        )


def get_price_history(symbol: str, since_ts: float) -> list[dict]:
    return _execute(
        "SELECT bucket_ts, price FROM price_history WHERE symbol = %s AND bucket_ts >= %s ORDER BY bucket_ts",
        (symbol, since_ts),
    ).fetchall()


def prune_price_history(before_ts: float) -> None:
    _execute("DELETE FROM price_history WHERE bucket_ts < %s", (before_ts,))


def platform_stats() -> dict[str, Any]:
    users = _execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
    active_positions = _execute("SELECT COUNT(*) c FROM positions WHERE qty != 0").fetchone()["c"]
    total_balance = _execute("SELECT COALESCE(SUM(balance), 0) s FROM users").fetchone()["s"]
    open_exposure = _execute("SELECT COALESCE(SUM(ABS(qty)), 0) s FROM positions").fetchone()["s"]
    return {
        "total_users": users,
        "users_with_open_position": active_positions,
        "total_balance": total_balance,
        "total_open_contracts": open_exposure,
    }
