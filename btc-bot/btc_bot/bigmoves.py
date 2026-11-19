"""Big-move log: every 1-hour candle in which a coin moved BIG_MOVE_PCT % or more UP or DOWN.

UP move   = how far the high got above the hour's open, in %.
DOWN move = how far the low got below the hour's open, in %.
An hour is recorded when either one reaches the threshold (BOTH if both did). The open-to-close change
is recorded too, so you can tell a move that held from a spike that came back.
Hours are shown in your computer's time zone.

Saved to logs/big_moves.csv, one row per coin per hour, never duplicated. It is filled from:
- the latest hourly candles on every refresh (about 4 months of history straight away), and
- the 5-year history, when you run the swing-time study.
"""
from __future__ import annotations

from datetime import datetime

import numpy as np
import pandas as pd

from .config import LOG_DIR, coin_name

MOVES_FILE = LOG_DIR / "big_moves.csv"
COLUMNS = ["time_utc", "local_time", "local_hour", "weekday", "coin", "direction", "up_pct", "down_pct",
           "change_pct", "open", "high", "low", "close"]


def _local_tz():
    return datetime.now().astimezone().tzinfo


def detect(candles: pd.DataFrame, symbol: str, threshold_pct: float, tz=None) -> pd.DataFrame:
    """Rows for every candle that went threshold_pct % above or below its open."""
    tz = tz or _local_tz()
    if candles.empty:
        return pd.DataFrame(columns=COLUMNS)
    up = (candles["high"] - candles["open"]) / candles["open"] * 100
    down = (candles["open"] - candles["low"]) / candles["open"] * 100
    chg = (candles["close"] - candles["open"]) / candles["open"] * 100
    is_up, is_down = up >= threshold_pct, down >= threshold_pct
    mask = is_up | is_down
    big = candles[mask]
    if big.empty:
        return pd.DataFrame(columns=COLUMNS)
    local = big.index.tz_convert(tz)
    direction = np.where(is_up[mask] & is_down[mask], "BOTH", np.where(is_up[mask], "UP", "DOWN"))
    return pd.DataFrame({
        "time_utc": big.index.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "local_time": local.strftime("%Y-%m-%d %H:%M"),
        "local_hour": local.hour,
        "weekday": local.strftime("%a"),
        "coin": coin_name(symbol),
        "direction": direction,
        "up_pct": up[mask].round(2).values,
        "down_pct": down[mask].round(2).values,
        "change_pct": chg[mask].round(2).values,
        "open": big["open"].values, "high": big["high"].values,
        "low": big["low"].values, "close": big["close"].values,
    })


def load() -> pd.DataFrame:
    try:
        return pd.read_csv(MOVES_FILE)
    except (OSError, ValueError):
        return pd.DataFrame(columns=COLUMNS)


def record(candles: pd.DataFrame, symbol: str, threshold_pct: float, tz=None) -> int:
    """Add any new big-move hours to the log. Returns how many were added."""
    new = detect(candles, symbol, threshold_pct, tz)
    if new.empty:
        return 0
    old = load()
    if not old.empty:
        seen = set(zip(old["coin"], old["time_utc"]))
        new = new[[(c, t) not in seen for c, t in zip(new["coin"], new["time_utc"])]]
    if new.empty:
        return 0
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    allrows = pd.concat([old, new], ignore_index=True) if not old.empty else new
    allrows.sort_values(["time_utc", "coin"]).to_csv(MOVES_FILE, index=False)
    return len(new)


def latest_text(moves: pd.DataFrame | None = None) -> str:
    moves = load() if moves is None else moves
    if moves.empty:
        return "Big moves: none recorded yet."
    last = moves.sort_values("time_utc").iloc[-1]
    return (f"Last 2%+ hour: {last['coin']} {last['local_time']}  {_move(last)}")


def _move(r) -> str:
    if r["direction"] == "UP":
        return f"UP +{r['up_pct']:.2f}%"
    if r["direction"] == "DOWN":
        return f"DOWN -{r['down_pct']:.2f}%"
    return f"BOTH +{r['up_pct']:.2f}% / -{r['down_pct']:.2f}%"


def report_text(threshold_pct: float, moves: pd.DataFrame | None = None, recent: int = 30) -> str:
    moves = load() if moves is None else moves
    lines = [f"BIG MOVES: hours where a coin went {threshold_pct:g}% or more UP or DOWN from the hour's open "
             "(your time zone)", ""]
    if moves.empty:
        return "\n".join(lines + ["Nothing recorded yet. It fills in on the next refresh."])
    t = pd.to_datetime(moves["time_utc"], utc=True)
    lines.append(f"Recorded: {len(moves):,} hours from {t.min():%Y-%m-%d} to {t.max():%Y-%m-%d}")
    for coin, g in moves.groupby("coin", sort=False):
        gt = pd.to_datetime(g["time_utc"], utc=True)
        span_days = max((gt.max() - gt.min()).days, 1)
        last30 = int((gt >= gt.max() - pd.Timedelta(days=30)).sum())
        n_up = int((g["direction"] == "UP").sum())
        n_down = int((g["direction"] == "DOWN").sum())
        n_both = len(g) - n_up - n_down
        lines += ["", f"== {coin}: {len(g):,} big hours ({len(g) / span_days:.2f} per day), {last30} in the last 30 days",
                  f"   {n_up} UP, {n_down} DOWN, {n_both} both ways.  Biggest: +{g['up_pct'].max():.2f}% up, "
                  f"-{g['down_pct'].max():.2f}% down"]
        counts = np.bincount(g["local_hour"].astype(int), minlength=24)
        peak = counts.max() or 1
        top = ", ".join(f"{h:02d}:00" for h in np.argsort(-counts)[:3])
        lines.append(f"   Busiest hours: {top}")
        for h in range(24):
            lines.append(f"   {h:02d}:00 {'#' * round(30 * counts[h] / peak):<30} {counts[h]}")
    lines += ["", f"Latest {recent}:", f"   {'Local time':<17}{'Coin':<6}{'Move':<28}{'Open to close':>14}"]
    for _, r in moves.sort_values("time_utc").tail(recent).iloc[::-1].iterrows():
        lines.append(f"   {r['local_time']:<17}{r['coin']:<6}{_move(r):<28}{r['change_pct']:>+13.2f}%")
    lines += ["", f"Full list: {MOVES_FILE}  (opens in Excel)"]
    return "\n".join(lines)
