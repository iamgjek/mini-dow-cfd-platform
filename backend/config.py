"""Simulated Mini Dow (小道瓊) CFD instrument parameters.

All values are illustrative and NOT sourced from a real broker feed. This
platform generates synthetic prices locally and never places real orders.
"""

INSTRUMENT_SYMBOL = "US30-MINI"
INSTRUMENT_NAME = "小道瓊 CFD (模擬)"

REFERENCE_PRICE = 42000.0
TICK_SIZE = 1.0
CONTRACT_MULTIPLIER = 5.0
SPREAD = 2.0

ANNUAL_VOLATILITY = 0.16
TICK_INTERVAL_SECONDS = 1.0

MARGIN_RATE = 0.05

# Default seed value for the "initial_balance" platform setting (new member
# starting balance). Admins can change the live value from the admin panel;
# this constant only matters the very first time the settings row is created.
INITIAL_BALANCE = 1_000.0

MAX_TICK_HISTORY = 3600
