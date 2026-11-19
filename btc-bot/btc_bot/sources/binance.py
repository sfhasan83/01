"""Binance public market data (no API key needed)."""
from __future__ import annotations

import pandas as pd

from . import INTERVAL_MS, rows_to_frame
from .http import get_json

BASE_URL = "https://api.binance.com"
MAX_LIMIT = 1000


def fetch_klines(symbol: str, interval: str, total: int = 1000) -> pd.DataFrame:
    """Fetch the most recent `total` candles, paging backwards 1000 at a time."""
    rows: list[list] = []
    end_time = None
    while len(rows) < total:
        params = {"symbol": symbol, "interval": interval, "limit": min(MAX_LIMIT, total - len(rows))}
        if end_time is not None:
            params["endTime"] = end_time
        batch = get_json(f"{BASE_URL}/api/v3/klines", params=params)
        if not batch:
            break
        rows = batch + rows
        end_time = int(batch[0][0]) - 1
        if len(batch) < params["limit"]:
            break
    return rows_to_frame(rows)


def fetch_price(symbol: str) -> float:
    data = get_json(f"{BASE_URL}/api/v3/ticker/price", params={"symbol": symbol})
    return float(data["price"])


__all__ = ["fetch_klines", "fetch_price", "INTERVAL_MS"]


def fetch_klines_since(symbol: str, interval: str, start_ms: int, progress=None) -> pd.DataFrame:
    """Every candle from start_ms until now, paging forward 1000 at a time (used for multi-year history)."""
    rows: list[list] = []
    start = start_ms
    while True:
        batch = get_json(f"{BASE_URL}/api/v3/klines",
                         params={"symbol": symbol, "interval": interval, "startTime": start, "limit": MAX_LIMIT})
        if not batch:
            break
        rows += batch
        if progress:
            progress(len(rows))
        if len(batch) < MAX_LIMIT:
            break
        start = int(batch[-1][0]) + INTERVAL_MS[interval]
    return rows_to_frame(rows)
