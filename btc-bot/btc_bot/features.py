"""Technical features built only from past and current candles (no look-ahead)."""
from __future__ import annotations

import numpy as np
import pandas as pd


def _rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False).mean()
    rs = gain / loss.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50)


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """Return a feature frame aligned with df's index. Rows with too little history are NaN."""
    o, h, l, c, v = (df[k] for k in ("open", "high", "low", "close", "volume"))
    logc = np.log(c)
    ret1 = logc.diff()
    f = pd.DataFrame(index=df.index)

    for n in (1, 2, 3, 6, 12, 24):
        f[f"ret_{n}"] = logc.diff(n)
    f["vol_12"] = ret1.rolling(12).std()
    f["vol_48"] = ret1.rolling(48).std()
    f["vol_ratio"] = f["vol_12"] / f["vol_48"]

    f["rsi_14"] = _rsi(c, 14) / 100 - 0.5
    f["rsi_6"] = _rsi(c, 6) / 100 - 0.5

    ema12 = c.ewm(span=12, adjust=False).mean()
    ema26 = c.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    f["macd_hist"] = (macd - macd.ewm(span=9, adjust=False).mean()) / c

    for n in (20, 50):
        ema = c.ewm(span=n, adjust=False).mean()
        f[f"dist_ema_{n}"] = c / ema - 1

    mid = c.rolling(20).mean()
    sd = c.rolling(20).std()
    f["bb_pctb"] = (c - (mid - 2 * sd)) / (4 * sd)

    prev_c = c.shift(1)
    tr = pd.concat([h - l, (h - prev_c).abs(), (l - prev_c).abs()], axis=1).max(axis=1)
    f["atr_14"] = tr.rolling(14).mean() / c

    rng = (h - l).replace(0, np.nan)
    f["body"] = ((c - o) / rng).fillna(0)
    f["upper_wick"] = ((h - np.maximum(o, c)) / rng).fillna(0)
    f["lower_wick"] = ((np.minimum(o, c) - l) / rng).fillna(0)

    logv = np.log1p(v)
    vz = (logv - logv.rolling(48).mean()) / logv.rolling(48).std().replace(0, np.nan)
    f["volume_z"] = vz.where(logv.rolling(48).count() < 48, vz.fillna(0)).clip(-6, 6)

    hour = df.index.hour + df.index.minute / 60
    f["hour_sin"] = np.sin(2 * np.pi * hour / 24)
    f["hour_cos"] = np.cos(2 * np.pi * hour / 24)
    f["weekday"] = df.index.dayofweek / 6

    return f.replace([np.inf, -np.inf], np.nan)


def build_target(df: pd.DataFrame) -> pd.Series:
    """1 if the NEXT candle closes higher than this one, 0 if not, NaN for the last candle."""
    nxt = df["close"].shift(-1)
    target = (nxt > df["close"]).astype(float)
    target[nxt.isna()] = np.nan
    return target
