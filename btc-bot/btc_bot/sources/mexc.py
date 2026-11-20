"""MEXC public market data (no API key needed)."""
from __future__ import annotations

import pandas as pd

from . import INTERVAL_MS, rows_to_frame
from .http import get_json

BASE_URL = "https://api.mexc.com"
MAX_LIMIT = 500
# MEXC spells the hourly interval "60m"
INTERVAL_NAMES = {"5m": "5m", "15m": "15m", "1h": "60m"}


def fetch_klines(symbol: str, interval: str, total: int = 500) -> pd.DataFrame:
    rows: list[list] = []
    end_time = None
    step = INTERVAL_MS[interval]
    while len(rows) < total:
        limit = min(MAX_LIMIT, total - len(rows))
        params = {"symbol": symbol, "interval": INTERVAL_NAMES[interval], "limit": limit}
        if end_time is not None:
            params["endTime"] = end_time
            params["startTime"] = end_time - step * limit
        batch = get_json(f"{BASE_URL}/api/v3/klines", params=params)
        if not batch:
            break
        rows = batch + rows
        end_time = int(batch[0][0]) - 1
        if len(batch) < limit:
            break
    return rows_to_frame(rows)


def fetch_price(symbol: str) -> float:
    data = get_json(f"{BASE_URL}/api/v3/ticker/price", params={"symbol": symbol})
    return float(data["price"])
