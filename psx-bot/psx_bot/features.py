"""Daily features for every stock, built only from data up to and including that day (no look-ahead).

All stocks are put on one shared trading calendar so "5 days ahead" means 5 trading sessions for
every stock. Days a stock did not trade carry its last close with zero volume (that is what the
price was if you wanted to sell). A stock whose data stops long before the latest session is
treated as suspended/delisted and is not extended.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import HORIZONS

STALE_SESSIONS = 10  # data ending more than this many sessions ago = suspended or delisted


def _rsi(close: pd.Series, period: int) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False).mean()
    rs = gain / loss.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50)


def trading_calendar(histories: dict[str, pd.DataFrame], min_share: float = 0.2) -> pd.DatetimeIndex:
    """Days on which a fair share of stocks traded (drops odd one-stock dates)."""
    counts = pd.Series(np.concatenate([df.index.values for df in histories.values()])).value_counts()
    need = max(1, int(len(histories) * min_share)) if len(histories) >= 10 else 1
    return pd.DatetimeIndex(sorted(counts[counts >= need].index))


def align(df: pd.DataFrame, cal: pd.DatetimeIndex) -> pd.DataFrame:
    """Put one stock on the shared calendar, from its first to its last trading day."""
    df = df[~df.index.duplicated(keep="last")]
    days = cal[(cal >= df.index.min()) & (cal <= df.index.max())]
    out = df.reindex(days)
    missing = out["close"].isna()
    out["close"] = out["close"].ffill()
    for k in ("open", "high", "low"):
        out[k] = out[k].where(~missing, out["close"])
    out["volume"] = out["volume"].fillna(0)
    out["traded"] = (~missing & (out["volume"] > 0)).astype(float)
    return out.dropna(subset=["close"])


def stock_features(df: pd.DataFrame) -> pd.DataFrame:
    o, h, l, c, v = (df[k] for k in ("open", "high", "low", "close", "volume"))
    logc = np.log(c)
    r1 = logc.diff()
    f = pd.DataFrame(index=df.index)
    for n in (1, 2, 5, 10, 20, 60, 120):
        f[f"ret_{n}"] = logc.diff(n)
    f["vol_10"] = r1.rolling(10).std()
    f["vol_60"] = r1.rolling(60).std()
    f["vol_ratio"] = f["vol_10"] / f["vol_60"]
    f["rsi_14"] = _rsi(c, 14) / 100 - 0.5
    f["rsi_5"] = _rsi(c, 5) / 100 - 0.5
    ema12, ema26 = c.ewm(span=12, adjust=False).mean(), c.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    f["macd_hist"] = (macd - macd.ewm(span=9, adjust=False).mean()) / c
    for n in (20, 50, 100, 200):
        f[f"dist_sma_{n}"] = c / c.rolling(n).mean() - 1
    mid, sd = c.rolling(20).mean(), c.rolling(20).std()
    f["bb_pctb"] = ((c - (mid - 2 * sd)) / (4 * sd)).clip(-1, 2)
    prev = c.shift(1)
    tr = pd.concat([h - l, (h - prev).abs(), (l - prev).abs()], axis=1).max(axis=1)
    f["atr_14"] = tr.rolling(14).mean() / c
    rng = (h - l).replace(0, np.nan)
    f["body"] = ((c - o) / rng).fillna(0)
    f["upper_wick"] = ((h - np.maximum(o, c)) / rng).fillna(0)
    f["lower_wick"] = ((np.minimum(o, c) - l) / rng).fillna(0)
    logv = np.log1p(v)
    f["volume_z"] = ((logv.rolling(5).mean() - logv.rolling(60).mean()) /
                     logv.rolling(60).std().replace(0, np.nan)).fillna(0).clip(-5, 5)
    turnover = (c * v).rolling(20).mean()
    f["log_turnover"] = np.log10(turnover + 1)
    f["traded_share"] = df["traded"].rolling(20).mean() if "traded" in df else (v > 0).rolling(20).mean()
    f["dist_high_250"] = c / c.rolling(250, min_periods=120).max() - 1
    f["dist_low_250"] = c / c.rolling(250, min_periods=120).min() - 1
    f["up_days_10"] = (r1 > 0).rolling(10).mean()
    f["log_price"] = np.log10(c)
    return f.replace([np.inf, -np.inf], np.nan)


def targets(df: pd.DataFrame) -> pd.DataFrame:
    """Forward log return over each horizon (NaN where the future is not known yet)."""
    logc = np.log(df["close"])
    return pd.DataFrame({f"fwd_{k}": logc.shift(-n) - logc for k, n in HORIZONS.items()}, index=df.index)


def build_panel(histories: dict[str, pd.DataFrame]) -> tuple[pd.DataFrame, pd.DatetimeIndex]:
    """One row per (date, symbol): features, market features, forward returns and price info."""
    cal = trading_calendar(histories)
    last_day = cal.max()
    frames = []
    for sym, raw in histories.items():
        df = align(raw, cal)
        if len(df) < 60:
            continue
        f = stock_features(df)
        f = f.join(targets(df))
        f["close"] = df["close"]
        f["high"], f["low"], f["volume"] = df["high"], df["low"], df["volume"]
        f["atr_abs"] = f["atr_14"] * df["close"]
        f["turnover_20"] = (df["close"] * df["volume"]).rolling(20).mean()
        f["sma_50"] = df["close"].rolling(50).mean()
        f["sma_200"] = df["close"].rolling(200).mean()
        f["symbol"] = sym
        # stale = data stopped long before the latest session (suspended / delisted)
        f["stale"] = len(cal[cal > df.index.max()]) > STALE_SESSIONS
        frames.append(f)
    if not frames:
        raise ValueError("No stock has enough history yet. Run 'Update data' first.")
    panel = pd.concat(frames)
    panel.index.name = "date"
    panel = panel.reset_index().set_index(["date", "symbol"]).sort_index()

    # Market-wide context, the same for every stock on a day (equal-weighted, robust medians)
    g = panel.groupby(level="date")
    mkt = pd.DataFrame({
        "mkt_ret_1": g["ret_1"].median(),
        "mkt_ret_5": g["ret_5"].median(),
        "mkt_ret_20": g["ret_20"].median(),
        "mkt_breadth_50": g["dist_sma_50"].apply(lambda s: (s > 0).mean()),
        "mkt_vol_10": g["ret_1"].std(),
    })
    panel = panel.join(mkt, on="date")
    for n in (5, 20, 60):
        panel[f"rel_ret_{n}"] = panel[f"ret_{n}"] - g[f"ret_{n}"].transform("median")
    for col in ("ret_5", "ret_20", "volume_z", "dist_sma_50", "log_turnover"):
        panel[f"rank_{col}"] = g[col].rank(pct=True) - 0.5
    panel.attrs["last_day"] = last_day
    return panel, cal


FEATURES = [
    "ret_1", "ret_2", "ret_5", "ret_10", "ret_20", "ret_60", "ret_120",
    "vol_10", "vol_60", "vol_ratio", "rsi_14", "rsi_5", "macd_hist",
    "dist_sma_20", "dist_sma_50", "dist_sma_100", "dist_sma_200", "bb_pctb", "atr_14",
    "body", "upper_wick", "lower_wick", "volume_z", "log_turnover", "traded_share",
    "dist_high_250", "dist_low_250", "up_days_10", "log_price",
    "mkt_ret_1", "mkt_ret_5", "mkt_ret_20", "mkt_breadth_50", "mkt_vol_10",
    "rel_ret_5", "rel_ret_20", "rel_ret_60",
    "rank_ret_5", "rank_ret_20", "rank_volume_z", "rank_dist_sma_50", "rank_log_turnover",
]
