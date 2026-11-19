"""Pulls data from every source and produces one prediction per timeframe."""
from __future__ import annotations

import csv
from dataclasses import dataclass, field
from datetime import datetime, timezone

import pandas as pd

from . import TIMEFRAMES
from .config import LOG_DIR, Settings
from .model import MovementModel, Signal, to_signal, training_frame
from .sources import INTERVAL_MS, binance, coinmarketcap, drop_unfinished, mexc, tradingview

EXCHANGES = {"binance": binance, "mexc": mexc}
PREDICTION_LOG = LOG_DIR / "predictions.csv"


@dataclass
class TimeframePrediction:
    timeframe: str
    signal: Signal | None
    last_close: float | None
    last_close_time: pd.Timestamp | None   # when the last closed candle closed (= start of target candle)
    target_close_time: pd.Timestamp | None  # when the predicted candle closes
    source: str
    tv: tradingview.TVRating
    tv_alert: dict | None = None
    error: str | None = None
    results: "SignalResults | None" = None

    @property
    def agrees_with_tv(self) -> bool | None:
        if not self.signal or self.signal.direction == "NEUTRAL" or self.tv.direction == "NEUTRAL":
            return None
        return self.signal.direction == self.tv.direction


@dataclass
class SignalResults:
    """How the bot's past calls on one timeframe turned out, once their candles closed.

    Every prediction is checked by its lean (P(up) above 0.5 means it leaned UP).
    "Signals" are only the confident UP/DOWN calls; NEUTRAL rows count as leans only.
    """
    hits: int = 0                # confident UP/DOWN signals that were right
    misses: int = 0              # confident UP/DOWN signals that were wrong
    all_hits: int = 0            # every checked prediction, judged by its lean
    all_checked: int = 0
    last_hit: bool | None = None          # True = YES hit, False = NO missed, None = nothing checked yet
    last_direction: str | None = None     # UP or DOWN (the lean, for NEUTRAL rows)
    last_is_lean: bool = False            # True when the last checked row was NEUTRAL
    last_target_close: pd.Timestamp | None = None
    last_from_price: float | None = None
    last_close_price: float | None = None

    @property
    def checked(self) -> int:
        return self.hits + self.misses

    @property
    def hit_rate(self) -> float | None:
        return self.hits / self.checked if self.checked else None

    @property
    def all_hit_rate(self) -> float | None:
        return self.all_hits / self.all_checked if self.all_checked else None


def _read_log() -> pd.DataFrame:
    if not PREDICTION_LOG.exists():
        return pd.DataFrame()
    try:
        log = pd.read_csv(PREDICTION_LOG)
    except (OSError, ValueError):
        return pd.DataFrame()
    if log.empty:
        return log
    for col in ("last_close_time_utc", "target_close_time_utc"):
        log[col] = pd.to_datetime(log[col], utc=True)
    # watch mode logs the same candle many times: keep the first call made for each candle
    return log.sort_values("created_utc").drop_duplicates(["timeframe", "target_close_time_utc"], keep="first")


def check_signals(log: pd.DataFrame, timeframe: str, candles: pd.DataFrame) -> pd.DataFrame:
    """Logged predictions for this timeframe whose candle has closed, with what really happened."""
    if log.empty:
        return pd.DataFrame()
    group = log[log["timeframe"] == timeframe]
    if group.empty:
        return pd.DataFrame()
    close_by_end = candles["close"].copy()
    close_by_end.index = candles.index + pd.to_timedelta(INTERVAL_MS[timeframe], unit="ms")
    actual = group["target_close_time_utc"].map(close_by_end)
    done = group[actual.notna()].copy()
    done["actual_close"] = actual[actual.notna()]
    done["went_up"] = done["actual_close"] > done["last_close"]
    done["said_up"] = done["p_up"] > 0.5
    done["hit"] = done["went_up"] == done["said_up"]
    return done.sort_values("target_close_time_utc")


def signal_results(checked: pd.DataFrame) -> SignalResults:
    res = SignalResults()
    if checked.empty:
        return res
    res.all_checked = int(len(checked))
    res.all_hits = int(checked["hit"].sum())
    calls = checked[checked["direction"] != "NEUTRAL"]
    res.hits = int(calls["hit"].sum())
    res.misses = int(len(calls) - res.hits)
    last = checked.iloc[-1]
    res.last_hit = bool(last["hit"])
    res.last_is_lean = last["direction"] == "NEUTRAL"
    res.last_direction = "UP" if last["p_up"] > 0.5 else "DOWN"
    res.last_target_close = last["target_close_time_utc"]
    res.last_from_price = float(last["last_close"])
    res.last_close_price = float(last["actual_close"])
    return res


@dataclass
class Snapshot:
    created: datetime
    predictions: list[TimeframePrediction]
    prices: dict[str, float | None] = field(default_factory=dict)
    cmc: coinmarketcap.MarketContext | None = None


def load_candles(settings: Settings, timeframe: str, total: int | None = None) -> tuple[pd.DataFrame, str]:
    """Closed candles from the primary exchange, falling back to the other one."""
    order = [settings.primary_exchange] + [e for e in EXCHANGES if e != settings.primary_exchange]
    errors = []
    for name in order:
        try:
            df = EXCHANGES[name].fetch_klines(settings.symbol, timeframe, total or settings.history_candles)
            df = drop_unfinished(df, timeframe)
            if len(df) >= 200:
                return df, name
            errors.append(f"{name}: only {len(df)} candles")
        except Exception as err:  # noqa: BLE001
            errors.append(f"{name}: {err}")
    raise ConnectionError("Could not load candles. " + " | ".join(errors))


def predict_timeframe(settings: Settings, timeframe: str) -> TimeframePrediction:
    tv = tradingview.fetch_rating(settings.symbol, timeframe)
    alert = tradingview.latest_alerts().get(timeframe)
    try:
        candles, source = load_candles(settings, timeframe)
        X, y, feats = training_frame(candles)
        model = MovementModel().fit(X, y)
        p_up = float(model.predict_up_proba(feats.iloc[[-1]])[0])
        last_open = feats.index[-1]
        step = pd.to_timedelta(INTERVAL_MS[timeframe], unit="ms")
        results = signal_results(check_signals(_read_log(), timeframe, candles))
        return TimeframePrediction(
            timeframe=timeframe,
            signal=to_signal(p_up, settings.confidence_threshold),
            last_close=float(candles.loc[last_open, "close"]),
            last_close_time=last_open + step,
            target_close_time=last_open + 2 * step,
            source=source, tv=tv, tv_alert=alert, results=results)
    except Exception as err:  # noqa: BLE001
        return TimeframePrediction(timeframe, None, None, None, None, "-", tv, alert, error=str(err))


def exchange_prices(symbol: str) -> dict[str, float | None]:
    prices: dict[str, float | None] = {}
    for name, mod in EXCHANGES.items():
        try:
            prices[name] = mod.fetch_price(symbol)
        except Exception:  # noqa: BLE001
            prices[name] = None
    return prices


def take_snapshot(settings: Settings, timeframes=TIMEFRAMES) -> Snapshot:
    preds = [predict_timeframe(settings, tf) for tf in timeframes]
    base = settings.symbol.replace("USDT", "").replace("USDC", "") or "BTC"
    snap = Snapshot(created=datetime.now(timezone.utc), predictions=preds,
                    prices=exchange_prices(settings.symbol),
                    cmc=coinmarketcap.fetch_context(settings.cmc_api_key, base))
    log_snapshot(snap)
    return snap


def log_snapshot(snap: Snapshot) -> None:
    """Append each prediction to logs/predictions.csv so its real accuracy can be checked later."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    new = not PREDICTION_LOG.exists()
    with PREDICTION_LOG.open("a", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        if new:
            w.writerow(["created_utc", "timeframe", "source", "last_close_time_utc", "target_close_time_utc",
                        "last_close", "p_up", "direction", "confidence", "tv_recommendation"])
        for p in snap.predictions:
            if not p.signal:
                continue
            w.writerow([snap.created.isoformat(timespec="seconds"), p.timeframe, p.source,
                        p.last_close_time.isoformat(), p.target_close_time.isoformat(), p.last_close,
                        round(p.signal.p_up, 4), p.signal.direction, round(p.signal.confidence, 4),
                        p.tv.recommendation or ""])


def score_log(settings: Settings) -> pd.DataFrame:
    """Compare logged predictions with what actually happened. Returns one row per timeframe."""
    log = _read_log()
    if log.empty:
        return pd.DataFrame()
    rows = []
    for tf in log["timeframe"].unique():
        candles, _ = load_candles(settings, tf, total=1000)
        done = check_signals(log, tf, candles)
        if done.empty:
            continue
        calls = done[done["direction"] != "NEUTRAL"]
        rows.append({
            "timeframe": tf,
            "checked": len(done),
            "accuracy": float(done["hit"].mean()),
            "signals": len(calls),
            "signal_hits": int(calls["hit"].sum()),
            "signal_hit_rate": float(calls["hit"].mean()) if len(calls) else float("nan"),
        })
    return pd.DataFrame(rows)
