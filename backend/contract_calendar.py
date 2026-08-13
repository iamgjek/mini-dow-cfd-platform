"""Calendar math for this platform's monthly futures contract rollover.

House rule (as specified by the platform operator, not a TAIFEX rule per
se): trade the near-month contract through the evening before its own
3rd-Wednesday settlement day, then roll to next month's contract. TAIFEX
itself already attributes a night session's trades to the *next* calendar
trading day, so rolling at ROLLOVER_HOUR:ROLLOVER_MINUTE on that evening
lines up with "the 3rd Wednesday trades the next month's contract."

Pure calendar functions only — no DB/network/app dependencies — so both
config.py (startup default) and rollover.py (the live runtime switch) can
import this without risking a circular import.
"""

import datetime as dt
from zoneinfo import ZoneInfo

TAIPEI = ZoneInfo("Asia/Taipei")

# Standard futures month codes, Jan..Dec.
MONTH_CODES = "FGHJKMNQUVXZ"

ROLLOVER_HOUR = 15
ROLLOVER_MINUTE = 45


def third_wednesday(year: int, month: int) -> dt.date:
    first = dt.date(year, month, 1)
    offset = (2 - first.weekday()) % 7  # Monday=0 ... Wednesday=2
    return first + dt.timedelta(days=offset + 14)


def _add_month(year: int, month: int) -> tuple[int, int]:
    return (year + 1, 1) if month == 12 else (year, month + 1)


def rollover_day(year: int, month: int) -> dt.date:
    """Last day `year`-`month`'s contract should be tradable — one day
    before that month's own 3rd Wednesday."""
    return third_wednesday(year, month) - dt.timedelta(days=1)


def contract_month_for(today: dt.date) -> tuple[int, int]:
    """(year, month) of the contract that should be the active front-month
    on `today`."""
    if today <= rollover_day(today.year, today.month):
        return today.year, today.month
    return _add_month(today.year, today.month)


def symbol_for(today: dt.date, base: str = "TFFITM", suffix: str = "+") -> str:
    year, month = contract_month_for(today)
    return f"{base}{MONTH_CODES[month - 1]}{suffix}"


def next_rollover_trigger(now: dt.datetime) -> dt.datetime:
    """Next Asia/Taipei instant to force-flatten positions and roll the
    active contract forward."""
    if now.tzinfo is None:
        now = now.replace(tzinfo=TAIPEI)
    year, month = now.year, now.month
    for _ in range(3):  # this month, then a couple ahead as a safety net
        trigger = dt.datetime.combine(
            rollover_day(year, month), dt.time(ROLLOVER_HOUR, ROLLOVER_MINUTE), tzinfo=TAIPEI
        )
        if trigger > now:
            return trigger
        year, month = _add_month(year, month)
    raise RuntimeError("could not compute next rollover trigger")
