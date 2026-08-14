import time
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field


class Side(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class OrderType(str, Enum):
    MARKET = "MARKET"
    LIMIT = "LIMIT"


class OrderStatus(str, Enum):
    PENDING = "PENDING"
    FILLED = "FILLED"
    CANCELLED = "CANCELLED"
    REJECTED = "REJECTED"


class Order(BaseModel):
    id: Optional[int] = None
    side: Side
    order_type: OrderType
    qty: float
    limit_price: Optional[float] = None
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None
    status: OrderStatus = OrderStatus.PENDING
    reject_reason: Optional[str] = None
    filled_price: Optional[float] = None
    filled_at: Optional[float] = None
    created_at: float = Field(default_factory=time.time)


class Position(BaseModel):
    qty: float = 0.0
    avg_price: float = 0.0
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None
    opened_at: Optional[float] = None


class Trade(BaseModel):
    id: Optional[int] = None
    order_id: int
    side: Side
    qty: float
    price: float
    realized_pnl: float = 0.0
    ts: float = Field(default_factory=time.time)


class Account(BaseModel):
    balance: float
    equity: float
    used_margin: float
    free_margin: float
    unrealized_pnl: float


class RegisterRequest(BaseModel):
    email: str
    password: str
    display_name: str


class LoginRequest(BaseModel):
    email: str
    password: str


class MeResponse(BaseModel):
    id: int
    email: str
    display_name: str
    role: str
    is_active: bool


class AdjustBalanceRequest(BaseModel):
    amount: float
    reason: Optional[str] = None


class SetRoleRequest(BaseModel):
    role: Literal["user", "admin"]


class UpdateSettingsRequest(BaseModel):
    initial_balance: float


class CreateUserRequest(BaseModel):
    email: str
    password: str
    display_name: str
    role: Literal["user", "admin"] = "user"
    initial_balance: Optional[float] = None


class UpdateUserRequest(BaseModel):
    display_name: Optional[str] = None
    email: Optional[str] = None
    password: Optional[str] = None
