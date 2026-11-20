"""Today's signals for every stock: train the pooled models on all saved history, score the latest day."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable

import numpy as np
import pandas as pd

from . import HORIZONS
from .config import LOG_DIR, Settings
from .features import build_panel
from .model import PooledModel, to_signal, training_rows, usable
from .store import load_all

SIGNALS_FILE = LOG_DIR / "signals.csv"
SCAN_FILE = LOG_DIR / "scan.json"
HISTORY_FILE = LOG_DIR / "signal_history.csv"
STOCK_RECORD_FILE = LOG_DIR / "backtest_stocks.csv"


@dataclass
class ScanResult:
    table: pd.DataFrame
    as_of: str
    created: str
    stocks: int
    breadth: float          # share of stocks above their 50-day average
    market_5d: float        # median 5-day move of all stocks, percent
    counts: dict = field(default_factory=dict)  # horizon -> {"BUY": n, "SELL": n, "HOLD": n}
    trained_rows: dict = field(default_factory=dict)
    base_rates: dict = field(default_factory=dict)  # horizon -> share of up moves in training data
    notes: list[str] = field(default_factory=list)


def levels(close: float, atr: float, n_days: int, side: str, settings: Settings) -> tuple[float, float]:
    """Take-profit and stop-loss from the stock's usual daily range (ATR), widened for longer horizons."""
    if not atr or atr != atr:
        return float("nan"), float("nan")
    scale = math.sqrt(n_days)
    up, down = settings.tp_atr_mult * atr * scale, settings.sl_atr_mult * atr * scale
    if side == "SELL":
        return close - up, close + down
    return close + up, close - down


def trend_text(close: float, sma50: float, sma200: float) -> str:
    if sma50 != sma50 or sma200 != sma200:
        return "new"
    if close > sma50 > sma200:
        return "Uptrend"
    if close < sma50 < sma200:
        return "Downtrend"
    return "Mixed"


def run_scan(settings: Settings, progress: Callable[[str], None] = print, fast: bool = False) -> ScanResult:
    progress("Loading saved prices...")
    histories, uni = load_all(settings)
    if not histories:
        raise ValueError("No saved prices yet. Run 'Update data' first (it downloads 5 years for every stock).")
    progress(f"Building features for {len(histories)} stocks...")
    panel, cal = build_panel(histories)
    last_day = cal.max()
    ok = usable(panel)
    latest = panel.xs(last_day, level="date", drop_level=False)
    latest = latest[ok.reindex(latest.index).fillna(False) & ~latest["stale"]]
    info = uni.set_index("symbol")

    table = pd.DataFrame(index=latest.index.get_level_values("symbol"))
    table["name"] = [info["name"].get(s, "") if s in info.index else "" for s in table.index]
    table["sector"] = [info["sector"].get(s, "") if s in info.index else "" for s in table.index]
    lv = latest.reset_index(level="date", drop=True)
    table["close"] = lv["close"]
    table["change_pct"] = (np.exp(lv["ret_1"]) - 1) * 100
    table["change_5d_pct"] = (np.exp(lv["ret_5"]) - 1) * 100
    table["rsi"] = (lv["rsi_14"] + 0.5) * 100
    table["trend"] = [trend_text(c, a, b) for c, a, b in zip(lv["close"], lv["sma_50"], lv["sma_200"])]
    table["turnover"] = lv["turnover_20"]
    table["liquid"] = lv["turnover_20"] >= settings.min_turnover
    table["atr"] = lv["atr_abs"]
    # 20-session support / resistance from the saved highs and lows
    sup, res = {}, {}
    for sym in table.index:
        h = histories[sym].tail(20)
        sup[sym], res[sym] = float(h["low"].min()), float(h["high"].max())
    table["support"], table["resistance"] = pd.Series(sup), pd.Series(res)

    result = ScanResult(table=table, as_of=last_day.strftime("%Y-%m-%d"),
                        created=datetime.now().isoformat(timespec="seconds"), stocks=len(table),
                        breadth=float((lv["dist_sma_50"] > 0).mean() * 100) if len(lv) else float("nan"),
                        market_5d=float((np.exp(lv["ret_5"].median()) - 1) * 100) if len(lv) else float("nan"))

    for i, (hz, n) in enumerate(HORIZONS.items(), start=1):
        progress(f"Training the {hz} model on all stocks ({i}/{len(HORIZONS)})...")
        X, y = training_rows(panel, hz)
        model = PooledModel(fast=fast).fit(X, y)
        result.trained_rows[hz] = int(len(X))
        base = float(y.mean())
        result.base_rates[hz] = base
        p = model.predict_up_proba(latest)
        sigs = [to_signal(v, settings.confidence_threshold, base) for v in p]
        table[f"p_{hz}"] = p
        table[f"sig_{hz}"] = [s.action for s in sigs]
        table[f"conf_{hz}"] = [s.confidence for s in sigs]
        tps, sls = [], []
        for sym, s in zip(table.index, sigs):
            side = "SELL" if s.p_up < 0.5 else "BUY"
            tp, sl = levels(table.at[sym, "close"], table.at[sym, "atr"], n, side, settings)
            tps.append(tp)
            sls.append(sl)
        table[f"tp_{hz}"], table[f"sl_{hz}"] = tps, sls
        result.counts[hz] = {a: int((table[f"sig_{hz}"] == a).sum()) for a in ("BUY", "SELL", "HOLD")}

    record = load_stock_record()
    if record is not None:
        table = table.join(record, how="left")
        result.table = table
    stale = int(panel.xs(last_day, level="date")["stale"].sum()) if last_day in panel.index.get_level_values(0) else 0
    missing = len(histories) - len(table) - stale
    if missing > 0:
        result.notes.append(f"{missing} stock{'s' if missing > 1 else ''} skipped: under about a year of "
                            "history, or no trades in the last 20 sessions.")
    save_scan(result)
    log_signals(result)
    progress("Done.")
    return result


# --- saving, so the window opens instantly with the last results ------------
def save_scan(r: ScanResult) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    r.table.to_csv(SIGNALS_FILE, index_label="symbol", float_format="%.6g")
    meta = {k: getattr(r, k) for k in ("as_of", "created", "stocks", "breadth", "market_5d", "counts",
                                       "trained_rows", "base_rates", "notes")}
    SCAN_FILE.write_text(json.dumps(meta, indent=1), encoding="utf-8")


def load_scan() -> ScanResult | None:
    try:
        meta = json.loads(SCAN_FILE.read_text(encoding="utf-8"))
        table = pd.read_csv(SIGNALS_FILE, index_col="symbol", keep_default_na=False, na_values=[""])
    except (OSError, ValueError):
        return None
    for k in ("name", "sector", "trend"):
        if k in table:
            table[k] = table[k].fillna("").astype(str)
    if "liquid" in table:
        table["liquid"] = table["liquid"].astype(str).str.lower().isin(("true", "1"))
    known = set(ScanResult.__dataclass_fields__)
    return ScanResult(table=table, **{k: v for k, v in meta.items() if k in known})


def log_signals(r: ScanResult) -> None:
    """Append today's calls (once per trading day) so the live track record can be checked later."""
    rows = []
    for hz in HORIZONS:
        for sym, row in r.table.iterrows():
            rows.append({"as_of": r.as_of, "symbol": sym, "horizon": hz, "p_up": round(float(row[f"p_{hz}"]), 4),
                         "signal": row[f"sig_{hz}"], "close": row["close"]})
    new = pd.DataFrame(rows)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if HISTORY_FILE.exists():
        try:
            old = pd.read_csv(HISTORY_FILE)
            old = old[old["as_of"] != r.as_of]  # a re-run on the same day replaces that day's calls
            new = pd.concat([old, new], ignore_index=True)
        except (OSError, ValueError):
            pass
    new.to_csv(HISTORY_FILE, index=False)


def live_record(settings: Settings) -> pd.DataFrame:
    """How past logged BUY/SELL calls turned out, per horizon."""
    from .store import load_history

    if not HISTORY_FILE.exists():
        return pd.DataFrame()
    log = pd.read_csv(HISTORY_FILE)
    log = log[log["signal"].isin(["BUY", "SELL"])]
    out = []
    cache: dict[str, pd.DataFrame | None] = {}
    for _, row in log.iterrows():
        sym = row["symbol"]
        if sym not in cache:
            cache[sym] = load_history(sym)
        h = cache[sym]
        if h is None:
            continue
        after = h[h.index > pd.Timestamp(row["as_of"])]
        n = HORIZONS.get(row["horizon"], 0)
        if len(after) < n or n == 0:
            continue
        move = after["close"].iloc[n - 1] / row["close"] - 1
        hit = move > 0 if row["signal"] == "BUY" else move < 0
        out.append({"horizon": row["horizon"], "signal": row["signal"], "hit": hit,
                    "move": move if row["signal"] == "BUY" else -move})
    if not out:
        return pd.DataFrame()
    df = pd.DataFrame(out)
    g = df.groupby(["horizon", "signal"])
    return pd.DataFrame({"calls": g.size(), "hit_rate": g["hit"].mean(),
                         "avg_gain_after_fees": g["move"].mean() - 2 * settings.fee_rate}).reset_index()


def load_stock_record() -> pd.DataFrame | None:
    try:
        return pd.read_csv(STOCK_RECORD_FILE, index_col="symbol")
    except (OSError, ValueError):
        return None
