"""TradingView signals.

TradingView has no official public data API, so the bot uses two routes:

1. The `tradingview-ta` library, which reads TradingView's own technical rating
   (the "Strong Buy ... Strong Sell" gauge on the Technicals page) for each timeframe.
2. Optional webhook alerts: set an alert in TradingView that posts to this bot
   (see btc_bot/webhook.py). The latest alert per timeframe is saved to logs/tv_alerts.json.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass

from ..config import LOG_DIR

ALERTS_FILE = LOG_DIR / "tv_alerts.json"


@dataclass
class TVRating:
    recommendation: str | None = None  # STRONG_BUY, BUY, NEUTRAL, SELL, STRONG_SELL
    buy: int = 0
    sell: int = 0
    neutral: int = 0
    error: str | None = None
    fetched: float = 0.0  # time.monotonic() when TradingView answered

    @property
    def direction(self) -> str:
        rec = (self.recommendation or "").upper()
        if "BUY" in rec:
            return "UP"
        if "SELL" in rec:
            return "DOWN"
        return "NEUTRAL"


# TradingView answers "HTTP 429" when asked too often, so ratings are cached per timeframe and
# all coins are fetched in ONE request per timeframe (3 requests per refresh at most).
CACHE_SECONDS = {"5m": 180, "15m": 300, "1h": 600}
BACKOFF_SECONDS = 600  # after a 429, leave TradingView alone for 10 minutes
_cache: dict[tuple[str, str], TVRating] = {}
_blocked_until: dict[str, float] = {}
_last_error: dict[str, str] = {}


def _interval_obj(interval: str):
    from tradingview_ta import Interval

    return {"5m": Interval.INTERVAL_5_MINUTES, "15m": Interval.INTERVAL_15_MINUTES,
            "1h": Interval.INTERVAL_1_HOUR}[interval]


def _fresh(symbol: str, interval: str) -> bool:
    r = _cache.get((symbol, interval))
    return bool(r and time.monotonic() - r.fetched < CACHE_SECONDS[interval])


def prefetch(symbols: list[str], interval: str, exchange: str = "BINANCE") -> None:
    """Refresh the cached ratings of every coin for one timeframe with a single request."""
    now = time.monotonic()
    if all(_fresh(s, interval) for s in symbols) or now < _blocked_until.get(interval, 0):
        return
    try:
        from tradingview_ta import get_multiple_analysis

        result = get_multiple_analysis(screener="crypto", interval=_interval_obj(interval),
                                       symbols=[f"{exchange}:{s}" for s in symbols], timeout=8)
        for s in symbols:
            analysis = result.get(f"{exchange}:{s}")
            if analysis is None:
                continue
            summary = analysis.summary
            _cache[(s, interval)] = TVRating(recommendation=summary.get("RECOMMENDATION"),
                                             buy=summary.get("BUY", 0), sell=summary.get("SELL", 0),
                                             neutral=summary.get("NEUTRAL", 0), fetched=now)
        _last_error.pop(interval, None)
    except ImportError:
        _last_error[interval] = "tradingview-ta not installed"
    except Exception as err:  # noqa: BLE001 - never crash on TradingView problems
        msg = str(err)
        if "429" in msg:
            _blocked_until[interval] = now + BACKOFF_SECONDS
            msg = "TradingView is limiting requests (HTTP 429); trying again in 10 minutes"
        elif "Expecting value" in msg or "JSON" in msg:
            # TradingView answered with an empty or non-JSON page, usually its way of turning away
            # automated requests for a while
            _blocked_until[interval] = now + BACKOFF_SECONDS
            msg = ("TradingView sent back an empty answer (it is probably limiting requests from your "
                   "connection); trying again in 10 minutes")
        else:
            _blocked_until[interval] = now + 120
        _last_error[interval] = msg


def fetch_rating(symbol: str, interval: str, exchange: str = "BINANCE") -> TVRating:
    """Cached TradingView rating. Shows the last good rating while TradingView is limiting requests."""
    if not _fresh(symbol, interval):
        prefetch([symbol], interval, exchange)
    cached = _cache.get((symbol, interval))
    if cached:
        return cached
    return TVRating(error=_last_error.get(interval, "no rating yet"))


def latest_alerts() -> dict:
    """Latest webhook alert per timeframe, e.g. {"5m": {"action": "buy", "received": "..."}}."""
    try:
        return json.loads(ALERTS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
