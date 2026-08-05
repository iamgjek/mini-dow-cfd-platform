import hashlib
import hmac
import secrets

from fastapi import Cookie, Depends, HTTPException, Request

from . import db

SESSION_COOKIE = "session_token"
SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
PBKDF2_ITERATIONS = 200_000


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), PBKDF2_ITERATIONS)
    return digest.hex(), salt


def verify_password(password: str, password_hash: str, salt: str) -> bool:
    computed, _ = hash_password(password, salt)
    return hmac.compare_digest(computed, password_hash)


def issue_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    db.create_session(token, user_id, SESSION_TTL_SECONDS)
    return token


def get_current_user(request: Request, session_token: str | None = Cookie(default=None)) -> dict:
    token = session_token or request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="not authenticated")
    user = db.get_session_user(token)
    if user is None:
        raise HTTPException(status_code=401, detail="session expired or invalid")
    if not user["is_active"]:
        raise HTTPException(status_code=403, detail="account disabled")
    return user


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="admin only")
    return user


def get_token_from_request(request: Request) -> str | None:
    return request.cookies.get(SESSION_COOKIE)


def user_from_ws_cookie(cookie_header: str | None) -> dict | None:
    if not cookie_header:
        return None
    cookies = {}
    for part in cookie_header.split(";"):
        if "=" in part:
            k, v = part.strip().split("=", 1)
            cookies[k] = v
    token = cookies.get(SESSION_COOKIE)
    if not token:
        return None
    user = db.get_session_user(token)
    if user is None or not user["is_active"]:
        return None
    return user
