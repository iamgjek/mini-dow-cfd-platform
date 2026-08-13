"""微小台指 (Micro TAIEX Futures) instrument + live quote feed configuration.

Price data comes from a real-time TCP quote feed (see backend/price_engine.py)
for a genuine market instrument — unlike the earlier Mini Dow CFD version of
this platform, prices here are real. Trading itself is still fully simulated:
orders are matched locally in-memory/DB, no order ever reaches a real
exchange, and no real money is at risk.
"""

import datetime as _dt
import os

from .contract_calendar import TAIPEI as _TAIPEI
from .contract_calendar import symbol_for as _symbol_for

# --- live quote feed (real, third-party data — see price_engine.py) ----------

TF_HOST = os.environ.get("TF_HOST", "121.199.14.113")
TF_PORT = int(os.environ.get("TF_PORT", "7781"))
TF_MARKET = os.environ.get("TF_MARKET", "TF")
TF_USERNAME = os.environ.get("TF_USERNAME", "")
TF_PASSWORD = os.environ.get("TF_PASSWORD", "")

# Which symbol on the feed to trade. TFFITM<month-code>+ = 微小台指 (Micro
# TAIEX futures) for a specific contract month — e.g. TFFITMQ+ = 2026-08.
# This platform trades the near-month contract and rolls to next month's
# code automatically at runtime (see rollover.py, driven by the calendar
# rule in contract_calendar.py), so the default below is *computed* from
# today's date rather than a hardcoded string — it stays correct across
# restarts/redeploys even before the rollover loop has run this process
# lifetime. Set TF_SYMBOL explicitly to override (e.g. to pin a specific
# contract for testing). Other codes seen on this feed include TFFITX1
# (大台指/standard TAIEX futures) and TFFIMTX8 (小台指/Mini TAIEX, current
# month, auto-rolling — what this app used before switching to the micro
# contract).
TF_SYMBOL = os.environ.get("TF_SYMBOL", _symbol_for(_dt.datetime.now(_TAIPEI).date()))

TF_HEARTBEAT_SECONDS = 120
MAX_TICK_HISTORY = 20_000

# --- simulated trading/account parameters -------------------------------------

# The live traded symbol is price_engine.symbol (mutable — see rollover.py),
# not this. TF_SYMBOL above only seeds its *initial* value at startup.
INSTRUMENT_NAME = "微小台指"
TICK_SIZE = 1.0

# Real contract spec: Micro TAIEX futures (微型臺股期貨) point value is NT$10.
CONTRACT_MULTIPLIER = 10.0

# Simplified illustrative margin model (percent of notional), not the real
# exchange's fixed-NT$ original-margin table.
MARGIN_RATE = 0.05

# Default seed value for the "initial_balance" platform setting (new member
# starting balance, in TWD). Admins can change the live value from the admin
# panel; this constant only matters the very first time the settings row is
# created.
INITIAL_BALANCE = 500_000.0
