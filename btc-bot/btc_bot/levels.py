"""Rebound levels: support (where price tends to bounce UP) and resistance (where it tends to bounce DOWN).

How levels are found
- Swing points: candles whose high (or low) is the highest (lowest) of the LEVEL_RADIUS candles on
  each side. Prices that turned there before are where buyers or sellers stepped in.
- Nearby swing prices (within LEVEL_TOL_ATR x ATR of each other) are merged into one level. The more
  swings a level has, the more often price has turned there.
- A level below the current price is support, above it is resistance.

How rebounds are measured (for each level shown)
- A "test" is a candle that comes within the level zone (+/- tolerance) from one side.
- REBOUND: within the next REBOUND_CANDLES candles price CLOSES at least 1 ATR (from the test candle's
  close) back toward the side it came from.
- BREAK: it closes at least 1 ATR the other way, through the level, first. Neither = undecided (not counted).
  The two distances are equal, so on purely random prices the rebound rate is about 50%: a level is
  only meaningful if it rebounds clearly MORE than half the time.
- The rebound rate is rebounds / (rebounds + breaks) over the history the bot has loaded.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .config import price_text
from .tpsl import atr

LEVEL_RADIUS = 5
LEVEL_TOL_ATR = 0.5
REBOUND_CANDLES = 6
LEVELS_EACH_SIDE = 3


@dataclass
class Level:
    price: float
    kind: str            # "support" or "resistance"
    swings: int          # swing points merged into this level
    tests: int           # times price came back to it (after it formed)
    rebounds: int
    breaks: int
    distance_pct: float  # from the current price

    @property
    def rebound_rate(self) -> float | None:
        decided = self.rebounds + self.breaks
        return self.rebounds / decided if decided else None

    @property
    def strength(self) -> str:
        """Rebound rate shrunk toward 50% when there are few tests, so 2 out of 2 isn't called strong."""
        decided = self.rebounds + self.breaks
        shrunk = (self.rebounds + 2) / (decided + 4)
        if decided >= 6 and shrunk >= 0.65:
            return "strong"
        if decided >= 2 and shrunk >= 0.55:
            return "medium"
        return "weak"


def swing_points(df: pd.DataFrame, radius: int = LEVEL_RADIUS) -> pd.DataFrame:
    win = 2 * radius + 1
    hi, lo = df["high"], df["low"]
    tops = hi[hi == hi.rolling(win, center=True).max()]
    bots = lo[lo == lo.rolling(win, center=True).min()]
    return pd.concat([pd.DataFrame({"price": tops, "type": "high"}),
                      pd.DataFrame({"price": bots, "type": "low"})]).sort_index()


def _cluster(points: pd.DataFrame, tol: float) -> list[dict]:
    """Greedy merge of swing prices that sit within `tol` of each other."""
    clusters: list[dict] = []
    for t, row in points.sort_values("price").iterrows():
        # compare with the cluster's lowest price, so a long chain of nearby swings can't drift into one huge level
        if clusters and row["price"] - clusters[-1]["prices"][0] <= tol:
            clusters[-1]["prices"].append(row["price"])
            clusters[-1]["times"].append(t)
        else:
            clusters.append({"prices": [row["price"]], "times": [t]})
    return [{"price": float(np.median(c["prices"])), "swings": len(c["prices"]), "first": min(c["times"])}
            for c in clusters]


def rebound_stats(df: pd.DataFrame, level: float, tol: float, start: pd.Timestamp, atr_s: pd.Series,
                  horizon: int = REBOUND_CANDLES) -> tuple[int, int, int]:
    """(tests, rebounds, breaks) for one level, using candles after `start`."""
    sub = df[df.index > start]
    if len(sub) < 3:
        return 0, 0, 0
    hi, lo, cl = sub["high"].values, sub["low"].values, sub["close"].values
    a = atr_s.reindex(sub.index).values
    tests = rebounds = breaks = 0
    i = 1
    while i < len(sub):
        prev = cl[i - 1]
        from_above = prev > level + tol and lo[i] <= level + tol
        from_below = prev < level - tol and hi[i] >= level - tol
        if not (from_above or from_below) or np.isnan(a[i]):
            i += 1
            continue
        tests += 1
        result = None
        ref = cl[i]  # measured from the close of the candle that tested the level, so both ways are equally far
        for j in range(i + 1, min(i + 1 + horizon, len(sub))):
            if from_above:
                if cl[j] <= ref - a[i]:
                    result = "break"
                elif cl[j] >= ref + a[i]:
                    result = "rebound"
            else:
                if cl[j] >= ref + a[i]:
                    result = "break"
                elif cl[j] <= ref - a[i]:
                    result = "rebound"
            if result:
                break
        rebounds += result == "rebound"
        breaks += result == "break"
        i += horizon  # don't count the same visit twice
    return tests, rebounds, breaks


def find_levels(df: pd.DataFrame, n_each_side: int = LEVELS_EACH_SIDE) -> tuple[list[Level], list[Level]]:
    """Nearest support levels (below price, closest first) and resistance levels (above price)."""
    if len(df) < 60:
        return [], []
    atr_s = atr(df)
    a_now = float(atr_s.iloc[-1])
    if not a_now or np.isnan(a_now):
        return [], []
    tol = LEVEL_TOL_ATR * a_now
    price = float(df["close"].iloc[-1])
    clusters = _cluster(swing_points(df), tol)
    below = sorted([c for c in clusters if c["price"] < price - tol * 0.5], key=lambda c: -c["price"])
    above = sorted([c for c in clusters if c["price"] > price + tol * 0.5], key=lambda c: c["price"])

    def build(cs, kind):
        out = []
        for c in cs[:n_each_side]:
            tests, reb, brk = rebound_stats(df, c["price"], tol, c["first"], atr_s)
            out.append(Level(price=c["price"], kind=kind, swings=c["swings"], tests=tests, rebounds=reb,
                             breaks=brk, distance_pct=(c["price"] / price - 1) * 100))
        return out
    return build(below, "support"), build(above, "resistance")


def level_text(lv: Level | None) -> str:
    """Short form for a table cell, e.g. '$62,810.00 · 5/7' (rebounded 5 of 7 tests)."""
    if lv is None:
        return "-"
    if lv.rebound_rate is None:
        return f"{price_text(lv.price)} · new"
    return f"{price_text(lv.price)} · {lv.rebounds}/{lv.rebounds + lv.breaks}"


def describe(lv: Level) -> str:
    rate = "no completed tests yet" if lv.rebound_rate is None else \
        f"rebounded {lv.rebounds} of {lv.rebounds + lv.breaks} times ({lv.rebound_rate:.0%}), broke {lv.breaks}"
    return (f"{lv.kind:<10} {price_text(lv.price):>13}  ({lv.distance_pct:+.2f}% away)  {lv.strength:<6}  "
            f"{lv.swings} swing points, {rate}")
