"""Walk-forward backtest over the saved years: train on the past, predict the next quarter, roll forward.

Every prediction is made by a model that never saw that day or anything after it. Training rows whose
outcome was not yet known on the prediction day are left out too (a 1-month outcome needs 20 more
sessions), so the numbers are an honest estimate of how the bot would have done.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import pandas as pd

from . import HORIZONS
from .config import LOG_DIR, Settings
from .features import build_panel
from .model import PooledModel, training_rows, usable
from .signals import STOCK_RECORD_FILE
from .store import load_all

REPORT_FILE = LOG_DIR / "backtest.txt"


@dataclass
class HorizonResult:
    horizon: str
    start: str
    end: str
    predictions: int
    accuracy: float
    always_up: float
    momentum: float
    threshold: float
    confident_share: float
    buy: dict = field(default_factory=dict)     # calls, hit, avg, avg_net, liquid_* ...
    sell: dict = field(default_factory=dict)
    market_avg: float = float("nan")            # average move of every stock over the horizon
    tpsl: dict = field(default_factory=dict)
    yearly: pd.DataFrame | None = None
    notes: list[str] = field(default_factory=list)


def _call_stats(fwd: pd.Series, hit: pd.Series, fee: float) -> dict:
    if len(fwd) == 0:
        return {"calls": 0, "hit": float("nan"), "avg": float("nan"), "avg_net": float("nan")}
    simple = np.expm1(fwd)
    return {"calls": int(len(fwd)), "hit": float(hit.mean()), "avg": float(simple.mean()),
            "avg_net": float(simple.mean() - 2 * fee)}


def _tpsl(panel: pd.DataFrame, calls: pd.Index, n: int, settings: Settings) -> dict:
    """For BUY calls: did the take-profit or the stop-loss get touched first within the horizon?"""
    out = {"TP": 0, "SL": 0, "EXPIRED": 0, "r": []}
    if len(calls) == 0:
        return {"trades": 0}
    by_sym: dict[str, list] = {}
    for d, s in calls:
        by_sym.setdefault(s, []).append(d)
    scale = np.sqrt(n)
    for sym, days in by_sym.items():
        g = panel.xs(sym, level="symbol")
        dates = g.index
        hi, lo, cl, atr = (g[k].to_numpy() for k in ("high", "low", "close", "atr_abs"))
        pos = dates.get_indexer(pd.DatetimeIndex(days))
        for i in pos:
            if i < 0 or i + n >= len(cl) or not atr[i] == atr[i]:
                continue
            tp = cl[i] + min(settings.tp_atr_mult * atr[i] * scale, cl[i] * 0.45)
            sl = cl[i] - min(settings.sl_atr_mult * atr[i] * scale, cl[i] * 0.45)
            risk = cl[i] - sl
            result = None
            for j in range(i + 1, i + n + 1):
                if lo[j] <= sl:  # same-day touch of both counts as a loss (worst case)
                    result = "SL"
                    break
                if hi[j] >= tp:
                    result = "TP"
                    break
            if result == "TP":
                r = (tp - cl[i]) / risk
            elif result == "SL":
                r = -1.0
            else:
                result = "EXPIRED"
                r = (cl[i + n] - cl[i]) / risk
            out[result] += 1
            out["r"].append(r)
    trades = out["TP"] + out["SL"] + out["EXPIRED"]
    return {"trades": trades, "TP": out["TP"], "SL": out["SL"], "EXPIRED": out["EXPIRED"],
            "avg_r": float(np.mean(out["r"])) if out["r"] else float("nan")}


def walk_forward(settings: Settings, progress: Callable[[str], None] = print, fast: bool = False,
                 step: int | None = None, min_train_sessions: int = 250, histories=None) -> list[HorizonResult]:
    if histories is None:
        progress("Loading saved prices...")
        histories, _ = load_all(settings)
    if not histories:
        raise ValueError("No saved prices yet. Run 'Update data' first.")
    progress(f"Building features for {len(histories)} stocks...")
    panel, cal = build_panel(histories)
    step = step or (126 if fast else 63)
    ok = usable(panel)
    dates = panel.index.get_level_values("date")
    day_pos = pd.Series(np.arange(len(cal)), index=cal)
    row_pos = day_pos.reindex(dates).to_numpy()
    usable_days = np.unique(row_pos[ok.to_numpy()])
    if len(usable_days) < min_train_sessions + 40:
        raise ValueError(f"Need at least {min_train_sessions + 40} sessions of usable history, "
                         f"have {len(usable_days)}. Download more years (YEARS in .env).")
    first_test = int(usable_days[0]) + min_train_sessions
    blocks = list(range(first_test, len(cal), step))
    results = []
    per_stock = {}
    for hz, n in HORIZONS.items():
        X_all, y_all = training_rows(panel, hz)
        x_pos = day_pos.reindex(X_all.index.get_level_values("date")).to_numpy()
        probs = pd.Series(np.nan, index=panel.index)
        bases = pd.Series(np.nan, index=panel.index)
        for b, start in enumerate(blocks, start=1):
            progress(f"Backtest {hz}: block {b}/{len(blocks)} (from {cal[start]:%Y-%m-%d})...")
            train = x_pos <= start - n   # outcome known by the prediction day
            if train.sum() < 5000:
                continue
            model = PooledModel(fast=fast).fit(X_all[train], y_all[train])
            test = ok.to_numpy() & (row_pos >= start) & (row_pos < start + step)
            if test.any():
                rows = np.flatnonzero(test)
                probs.iloc[rows] = model.predict_up_proba(panel[test])
                bases.iloc[rows] = float(y_all[train].mean())
        res, stock = _evaluate(panel, probs, bases, hz, n, settings)
        results.append(res)
        per_stock[hz] = stock
    _save_stock_record(per_stock)
    REPORT_FILE.parent.mkdir(parents=True, exist_ok=True)
    REPORT_FILE.write_text(report_text(results, settings), encoding="utf-8")
    progress("Backtest done.")
    return results


def _evaluate(panel, probs, bases, hz, n, settings) -> tuple[HorizonResult, pd.DataFrame]:
    fwd = panel[f"fwd_{hz}"]
    mask = probs.notna() & fwd.notna()
    p, f, base = probs[mask], fwd[mask], bases[mask]
    moved = f != 0
    up = f > 0
    thr = settings.confidence_threshold
    margin = thr - 0.5  # same rule as live signals: measured from the usual share of up moves
    buy = p >= base + margin
    sell = p <= base - margin
    liquid = panel.loc[mask, "turnover_20"] >= settings.min_turnover
    past = panel.loc[mask, f"ret_{n}" if f"ret_{n}" in panel else "ret_5"]
    dates = p.index.get_level_values("date")
    res = HorizonResult(
        horizon=hz, start=f"{dates.min():%Y-%m-%d}", end=f"{dates.max():%Y-%m-%d}",
        predictions=int(moved.sum()),
        accuracy=float(((p > 0.5) == up)[moved].mean()),
        always_up=float(up[moved].mean()),
        momentum=float(((past > 0) == up)[moved & (past != 0)].mean()),
        threshold=thr, confident_share=float((buy | sell).mean()),
        market_avg=float(np.expm1(f).mean()),
    )
    fee = settings.fee_rate
    res.buy = _call_stats(f[buy], up[buy], fee)
    down = f < 0
    res.sell = _call_stats(f[sell], down[sell], fee)
    res.buy["liquid"] = _call_stats(f[buy & liquid], up[buy & liquid], fee)
    res.sell["liquid"] = _call_stats(f[sell & liquid], down[sell & liquid], fee)
    res.buy["market_liquid_avg"] = float(np.expm1(f[liquid]).mean()) if liquid.any() else float("nan")
    res.tpsl = _tpsl(panel, p[buy & liquid].index, n, settings)

    year = dates.year
    yearly = pd.DataFrame({
        "buy_calls": buy.groupby(year).sum(),
        "buy_hit": up[buy].groupby(year[buy.to_numpy()]).mean(),
        "buy_avg": np.expm1(f[buy]).groupby(year[buy.to_numpy()]).mean(),
        "all_stocks_avg": np.expm1(f).groupby(year).mean(),
    })
    res.yearly = yearly

    best = max(res.always_up, 1 - res.always_up, res.momentum)
    if res.accuracy <= best + 0.01:
        res.notes.append("No clear edge in plain up/down accuracy over a simple rule.")
    if res.buy["calls"] and res.buy["avg"] <= res.market_avg:
        res.notes.append("BUY calls did not beat the average stock over the same days.")
    if res.buy["calls"] and res.buy["avg_net"] < 0:
        res.notes.append("Following BUY calls LOST money after fees.")

    syms = p.index.get_level_values("symbol")
    called = buy | sell
    hit = (buy & up) | (sell & down)
    stock = pd.DataFrame({"calls": called.groupby(syms).sum(), "hits": hit.groupby(syms).sum()})
    stock["hit_rate"] = stock["hits"] / stock["calls"].replace(0, np.nan)
    return res, stock


def _save_stock_record(per_stock: dict) -> None:
    parts = []
    for hz, df in per_stock.items():
        parts.append(df[["calls", "hit_rate"]].rename(columns={"calls": f"bt_calls_{hz}",
                                                               "hit_rate": f"bt_hit_{hz}"}))
    if parts:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        pd.concat(parts, axis=1).to_csv(STOCK_RECORD_FILE, index_label="symbol", float_format="%.4f")


def report_text(results: list[HorizonResult], settings: Settings) -> str:
    pc = lambda x: "n/a" if x != x else f"{x * 100:.1f}%"  # noqa: E731
    sg = lambda x: "n/a" if x != x else f"{x * 100:+.2f}%"  # noqa: E731
    lines = ["PSX signal bot: walk-forward backtest on all stocks",
             f"Fees assumed: {settings.fee_rate * 100:.2f}% per side.  Confidence for a BUY/SELL call: "
             f"{settings.confidence_threshold:.0%} (measured from the usual share of up moves).  'Liquid' = 20-day average turnover at least "
             f"Rs {settings.min_turnover:,.0f} a day.", ""]
    for r in results:
        b, s = r.buy, r.sell
        lines += [
            f"== {r.horizon} ahead ({HORIZONS[r.horizon]} sessions). Out-of-sample {r.start} to {r.end}, "
            f"{r.predictions:,} stock-days",
            f"  Up/down accuracy, all stock-days:         {pc(r.accuracy)}",
            f"  'Always up' rule:                         {pc(r.always_up)}",
            f"  'Same way as the last {HORIZONS[r.horizon]} sessions' rule:  {pc(r.momentum)}",
            f"  Average stock over the horizon:           {sg(r.market_avg)}",
            f"  BUY calls:  {b['calls']:,}, right {pc(b['hit'])}, average move {sg(b['avg'])}, "
            f"after fees {sg(b['avg_net'])}",
            f"     liquid only: {b['liquid']['calls']:,}, right {pc(b['liquid']['hit'])}, after fees "
            f"{sg(b['liquid']['avg_net'])} (average liquid stock {sg(b.get('market_liquid_avg', float('nan')))})",
            f"  SELL calls: {s['calls']:,}, right {pc(s['hit'])}, average move {sg(s['avg'])} "
            f"(negative = the warning was useful)",
            f"     liquid only: {s['liquid']['calls']:,}, right {pc(s['liquid']['hit'])}, "
            f"average move {sg(s['liquid']['avg'])}",
        ]
        t = r.tpsl
        if t.get("trades"):
            lines.append(f"  TP/SL plan on liquid BUY calls (TP {settings.tp_atr_mult:g}xATR, SL "
                         f"{settings.sl_atr_mult:g}xATR, scaled to the horizon): {t['trades']:,} trades, "
                         f"TP first {pc(t['TP'] / t['trades'])}, SL first {pc(t['SL'] / t['trades'])}, "
                         f"neither {pc(t['EXPIRED'] / t['trades'])}; average {t['avg_r']:+.2f}R")
        if r.yearly is not None and not r.yearly.empty:
            lines.append("  By year:  year  BUY calls  right   BUY avg   all stocks avg")
            for y, row in r.yearly.iterrows():
                lines.append(f"            {y}  {int(row['buy_calls'] or 0):>9,}  {pc(row['buy_hit']):>6}  "
                             f"{sg(row['buy_avg']):>8}  {sg(row['all_stocks_avg']):>8}")
        lines += [f"  ! {n}" for n in r.notes]
        lines.append("")
    lines.append("Read this before trusting a call: being right more than half the time is not enough. "
                 "BUY calls must beat the average stock after fees, in most years, to be worth following.")
    return "\n".join(lines)
