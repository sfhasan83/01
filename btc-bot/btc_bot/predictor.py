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

    @property
    def agrees_with_tv(self) -> bool | None:
        if not self.signal or self.signal.direction == "NEUTRAL" or self.tv.direction == "NEUTRAL":
            return None
        return self.signal.direction == self.tv.direction


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
        return TimeframePrediction(
            timeframe=timeframe,
            signal=to_signal(p_up, settings.confidence_threshold),
            last_close=float(candles.loc[last_open, "close"]),
            last_close_time=last_open + step,
            target_close_time=last_open + 2 * step,
            source=source, tv=tv, tv_alert=alert)
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
    if not PREDICTION_LOG.exists():
        return pd.DataFrame()
    log = pd.read_csv(PREDICTION_LOG, parse_dates=["last_close_time_utc", "target_close_time_utc"])
    # one prediction per target candle (watch mode logs the same candle many times)
    log = log.sort_values("created_utc").drop_duplicates(["timeframe", "target_close_time_utc"], keep="first")
    rows = []
    for tf, group in log.groupby("timeframe"):
        candles, _ = load_candles(settings, tf, total=1000)
        close_by_end = candles["close"].copy()
        close_by_end.index = candles.index + pd.to_timedelta(INTERVAL_MS[tf], unit="ms")
        actual = group["target_close_time_utc"].map(close_by_end)
        done = actual.notna()
        if not done.any():
            continue
        g = group[done]
        went_up = actual[done].values > g["last_close"].values
        said_up = g["p_up"].values > 0.5
        conf = g["direction"].values != "NEUTRAL"
        rows.append({
            "timeframe": tf,
            "checked": int(done.sum()),
            "accuracy": float((went_up == said_up).mean()),
            "confident_calls": int(conf.sum()),
            "confident_accuracy": float((went_up[conf] == said_up[conf]).mean()) if conf.any() else float("nan"),
        })
    return pd.DataFrame(rows)
