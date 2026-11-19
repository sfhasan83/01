"""Market data sources. Every exchange source returns the same candle DataFrame:

index: open_time (UTC, tz-aware); columns: open, high, low, close, volume, close_time
"""
from __future__ import annotations

import pandas as pd

CANDLE_COLUMNS = ["open", "high", "low", "close", "volume", "close_time"]

INTERVAL_MS = {"5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000}


def rows_to_frame(rows: list[list]) -> pd.DataFrame:
    """Turn raw kline rows [open_time, open, high, low, close, volume, close_time?, ...] into a frame."""
    if not rows:
        return pd.DataFrame(columns=CANDLE_COLUMNS)
    df = pd.DataFrame([r[:7] if len(r) >= 7 else list(r[:6]) + [None] for r in rows],
                      columns=["open_time"] + CANDLE_COLUMNS)
    df["open_time"] = pd.to_datetime(df["open_time"].astype("int64"), unit="ms", utc=True)
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = df[col].astype(float)
    df = df.drop_duplicates("open_time").set_index("open_time").sort_index()
    return df


def drop_unfinished(df: pd.DataFrame, interval: str, now: pd.Timestamp | None = None) -> pd.DataFrame:
    """Remove the candle that is still forming, so we only learn from and predict off closed candles."""
    if df.empty:
        return df
    now = now or pd.Timestamp.now(tz="UTC")
    end = df.index + pd.to_timedelta(INTERVAL_MS[interval], unit="ms")
    return df[end <= now]
