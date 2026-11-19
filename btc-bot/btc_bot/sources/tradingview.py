"""TradingView signals.

TradingView has no official public data API, so the bot uses two routes:

1. The `tradingview-ta` library, which reads TradingView's own technical rating
   (the "Strong Buy ... Strong Sell" gauge on the Technicals page) for each timeframe.
2. Optional webhook alerts: set an alert in TradingView that posts to this bot
   (see btc_bot/webhook.py). The latest alert per timeframe is saved to logs/tv_alerts.json.
"""
from __future__ import annotations

import json
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

    @property
    def direction(self) -> str:
        rec = (self.recommendation or "").upper()
        if "BUY" in rec:
            return "UP"
        if "SELL" in rec:
            return "DOWN"
        return "NEUTRAL"


def fetch_rating(symbol: str, interval: str, exchange: str = "BINANCE") -> TVRating:
    try:
        from tradingview_ta import Interval, TA_Handler
    except ImportError:
        return TVRating(error="tradingview-ta not installed")
    intervals = {"5m": Interval.INTERVAL_5_MINUTES, "15m": Interval.INTERVAL_15_MINUTES,
                 "1h": Interval.INTERVAL_1_HOUR}
    try:
        handler = TA_Handler(symbol=symbol, exchange=exchange, screener="crypto",
                             interval=intervals[interval], timeout=15)
        summary = handler.get_analysis().summary
        return TVRating(recommendation=summary.get("RECOMMENDATION"), buy=summary.get("BUY", 0),
                        sell=summary.get("SELL", 0), neutral=summary.get("NEUTRAL", 0))
    except Exception as err:  # noqa: BLE001 - never crash on TradingView problems
        return TVRating(error=str(err))


def latest_alerts() -> dict:
    """Latest webhook alert per timeframe, e.g. {"5m": {"action": "buy", "received": "..."}}."""
    try:
        return json.loads(ALERTS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
