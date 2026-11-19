"""Walk-forward backtest: train on the past, predict the next block, roll forward, repeat.

Every prediction is made by a model that never saw the candle it is predicting,
so the accuracy here is an honest estimate of how the bot would have done.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .model import MovementModel, training_frame


@dataclass
class BacktestResult:
    timeframe: str
    n_predictions: int
    accuracy: float
    baseline_up: float          # accuracy of always saying "UP"
    baseline_momentum: float    # accuracy of "same direction as last candle"
    threshold: float
    confident_share: float      # share of candles where the bot made an UP/DOWN call
    confident_accuracy: float   # accuracy on those calls only
    strategy_return: float      # sum of returns following confident calls, after fees
    buy_hold_return: float
    fee_rate: float
    start: pd.Timestamp | None = None
    end: pd.Timestamp | None = None
    notes: list[str] = field(default_factory=list)


def walk_forward(candles: pd.DataFrame, timeframe: str, threshold: float = 0.58,
                 fee_rate: float = 0.001, train_size: int = 1500, step: int = 100) -> BacktestResult:
    X, y, _ = training_frame(candles)
    if len(X) < train_size + step:
        raise ValueError(f"Need at least {train_size + step} usable candles for {timeframe}, got {len(X)}. "
                         "Raise HISTORY_CANDLES in .env.")

    probs = pd.Series(np.nan, index=X.index)
    for start in range(train_size, len(X), step):
        lo = start - train_size
        # The target of row start-1 uses the close of row start, which is "now" for the
        # first prediction in this block, so training up to start-1 is still look-ahead free.
        model = MovementModel().fit(X.iloc[lo:start], y.iloc[lo:start])
        block = X.iloc[start:start + step]
        probs.iloc[start:start + step] = model.predict_up_proba(block)

    mask = probs.notna()
    p = probs[mask]
    actual = y[mask]
    pred_up = p > 0.5
    close = candles["close"]
    next_ret = (close.shift(-1) / close - 1).reindex(p.index)

    conf = np.maximum(p, 1 - p)
    confident = conf >= threshold
    position = np.where(pred_up, 1.0, -1.0) * confident
    strat = (position * next_ret - confident * 2 * fee_rate).sum()

    prev_up = (close.diff() > 0).reindex(p.index)
    res = BacktestResult(
        timeframe=timeframe,
        n_predictions=int(mask.sum()),
        accuracy=float((pred_up == (actual == 1)).mean()),
        baseline_up=float((actual == 1).mean()),
        baseline_momentum=float((prev_up == (actual == 1)).mean()),
        threshold=threshold,
        confident_share=float(confident.mean()),
        confident_accuracy=float((pred_up[confident] == (actual[confident] == 1)).mean())
        if confident.any() else float("nan"),
        strategy_return=float(strat),
        buy_hold_return=float(close.reindex(p.index).iloc[-1] / close.reindex(p.index).iloc[0] - 1),
        fee_rate=fee_rate,
        start=p.index[0],
        end=p.index[-1],
    )
    best_baseline = max(res.baseline_up, 1 - res.baseline_up, res.baseline_momentum)
    if res.accuracy <= best_baseline + 0.01:
        res.notes.append("No real edge: accuracy is not clearly better than a simple rule.")
    if confident.any() and res.strategy_return < 0:
        res.notes.append("Trading every confident call would have LOST money after fees.")
    return res


def format_result(r: BacktestResult) -> str:
    pct = lambda x: "n/a" if x != x else f"{x * 100:.1f}%"  # noqa: E731
    lines = [
        f"== {r.timeframe} backtest  ({r.n_predictions} out-of-sample candles, "
        f"{r.start:%Y-%m-%d %H:%M} to {r.end:%Y-%m-%d %H:%M} UTC)",
        f"  Direction accuracy (all candles):      {pct(r.accuracy)}",
        f"  Always-UP rule:                        {pct(r.baseline_up)}",
        f"  'Same as last candle' rule:            {pct(r.baseline_momentum)}",
        f"  Confident calls (>= {r.threshold:.0%}):            {pct(r.confident_share)} of candles, "
        f"{pct(r.confident_accuracy)} correct",
        f"  Following confident calls, after fees: {r.strategy_return * 100:+.2f}%  "
        f"(fee {r.fee_rate * 100:.2f}% per side; buy-and-hold {r.buy_hold_return * 100:+.2f}%)",
    ]
    lines += [f"  ! {n}" for n in r.notes]
    return "\n".join(lines)
