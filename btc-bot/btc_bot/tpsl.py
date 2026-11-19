"""Take Profit / Stop Loss levels and tracking.

Levels are based on ATR (Average True Range, the typical size of one candle on that timeframe):

    LONG:  stop loss = entry - SL_ATR_MULT x ATR    take profit = entry + TP_ATR_MULT x ATR
    SHORT: stop loss = entry + SL_ATR_MULT x ATR    take profit = entry - TP_ATR_MULT x ATR

The entry is the close of the last finished candle. After the call, the bot watches up to
TP_SL_CANDLES candles: whichever level price touches first decides the result. If both are touched
inside the same candle we can't tell which came first, so it is counted as a stop loss (the cautious
choice). If neither is touched in time, the trade "expires" at that candle's close.
These are suggestions only; the bot never places orders.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


def atr(candles: pd.DataFrame, period: int = 14) -> pd.Series:
    prev = candles["close"].shift(1)
    tr = pd.concat([candles["high"] - candles["low"], (candles["high"] - prev).abs(),
                    (candles["low"] - prev).abs()], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def levels(entry: float, side: str, atr_value: float, sl_mult: float, tp_mult: float) -> tuple[float, float]:
    """(take_profit, stop_loss) for a LONG or SHORT entered at `entry`."""
    if side == "LONG":
        return entry + tp_mult * atr_value, entry - sl_mult * atr_value
    return entry - tp_mult * atr_value, entry + sl_mult * atr_value


def outcome(side: str, tp: float, sl: float, future: pd.DataFrame, max_candles: int) -> tuple[str, float | None]:
    """Walk the candles after entry. Returns (result, exit_price).

    result is TP, SL, EXPIRED (no level touched within max_candles) or OPEN (still running).
    """
    for i, (_, c) in enumerate(future.iloc[:max_candles].iterrows()):
        if side == "LONG":
            hit_sl, hit_tp = c["low"] <= sl, c["high"] >= tp
        else:
            hit_sl, hit_tp = c["high"] >= sl, c["low"] <= tp
        if hit_sl:  # also when both are hit in one candle: assume the worse case
            return "SL", sl
        if hit_tp:
            return "TP", tp
        if i == max_candles - 1:
            return "EXPIRED", float(c["close"])
    return "OPEN", None


def r_multiple(side: str, entry: float, sl: float, exit_price: float) -> float:
    """Profit or loss measured in units of risk (1R = distance from entry to stop loss)."""
    risk = abs(entry - sl)
    if risk == 0:
        return 0.0
    move = exit_price - entry if side == "LONG" else entry - exit_price
    return move / risk


@dataclass
class TPSLResults:
    tp: int = 0
    sl: int = 0
    expired: int = 0
    open: int = 0
    total_r: float = 0.0
    last_outcome: str | None = None   # TP, SL or EXPIRED for the latest finished trade
    last_side: str | None = None
    last_entry_close: pd.Timestamp | None = None

    @property
    def finished(self) -> int:
        return self.tp + self.sl + self.expired

    @property
    def tp_rate(self) -> float | None:
        return self.tp / self.finished if self.finished else None


def evaluate(group: pd.DataFrame, candles: pd.DataFrame, max_candles: int) -> TPSLResults:
    """Score logged predictions (needs columns last_close_time_utc, last_close, p_up, tp, sl)."""
    res = TPSLResults()
    if group.empty or "tp" not in group.columns:
        return res
    group = group.dropna(subset=["tp", "sl"]).sort_values("last_close_time_utc")
    for _, row in group.iterrows():
        side = "LONG" if row["p_up"] > 0.5 else "SHORT"
        # candles that opened at or after the moment the call was made
        future = candles[candles.index >= row["last_close_time_utc"]]
        result, exit_price = outcome(side, row["tp"], row["sl"], future, max_candles)
        if result == "OPEN":
            res.open += 1
            continue
        setattr(res, result.lower(), getattr(res, result.lower()) + 1)
        res.total_r += r_multiple(side, row["last_close"], row["sl"], exit_price)
        res.last_outcome, res.last_side = result, side
        res.last_entry_close = row["last_close_time_utc"]
    return res


def simulate(candles: pd.DataFrame, entries: pd.Series, sides: pd.Series, sl_mult: float, tp_mult: float,
             max_candles: int, fee_rate: float) -> dict:
    """Backtest helper: TP/SL outcome for each entry candle (index = entry candle's open time)."""
    a = atr(candles)
    pos = {t: i for i, t in enumerate(candles.index)}
    counts = {"TP": 0, "SL": 0, "EXPIRED": 0}
    r_total, pnl = 0.0, 0.0
    for t in entries.index:
        i, atr_v = pos[t], a.loc[t]
        if np.isnan(atr_v) or atr_v <= 0:
            continue
        entry = float(candles["close"].iloc[i])
        side = sides.loc[t]
        tp, sl = levels(entry, side, atr_v, sl_mult, tp_mult)
        result, exit_price = outcome(side, tp, sl, candles.iloc[i + 1:], max_candles)
        if result == "OPEN":
            continue
        counts[result] += 1
        r_total += r_multiple(side, entry, sl, exit_price)
        move = (exit_price - entry) / entry if side == "LONG" else (entry - exit_price) / entry
        pnl += move - 2 * fee_rate
    n = sum(counts.values())
    return {"trades": n, **counts, "tp_rate": counts["TP"] / n if n else float("nan"),
            "avg_r": r_total / n if n else float("nan"), "return_after_fees": pnl}
