"""One model per horizon, trained on ALL stocks together (a pooled model).

Five years of one stock is only ~1,200 days, too little to learn from on its own. Pooled across
every listed stock it is several hundred thousand examples, and the features are scaled (returns,
ratios, ranks) so they mean the same thing for a Rs 10 stock and a Rs 1,000 stock.
Output: the probability that the stock closes higher after the horizon than it did today.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .features import FEATURES

MAX_TRAIN_ROWS = 400_000


class PooledModel:
    def __init__(self, random_state: int = 7, fast: bool = False):
        self.linear = make_pipeline(StandardScaler(), LogisticRegression(C=0.05, max_iter=300))
        self.trees = HistGradientBoostingClassifier(
            max_depth=3, learning_rate=0.05, max_iter=60 if fast else 150, min_samples_leaf=400,
            l2_regularization=5.0, random_state=random_state)
        self.random_state = random_state
        self.fitted = False

    def fit(self, X: pd.DataFrame, y: pd.Series) -> "PooledModel":
        if len(X) > MAX_TRAIN_ROWS:  # keep training time reasonable on slow PCs; recent rows matter most
            keep = np.random.default_rng(self.random_state).choice(len(X), MAX_TRAIN_ROWS, replace=False)
            keep.sort()
            X, y = X.iloc[keep], y.iloc[keep]
        if y.nunique() < 2:
            raise ValueError("Training data only moves one way; need more history")
        self.linear.fit(X[FEATURES].values, y.values)
        self.trees.fit(X[FEATURES].values, y.values)
        self.fitted = True
        return self

    def predict_up_proba(self, X: pd.DataFrame) -> np.ndarray:
        vals = X[FEATURES].values
        return 0.4 * self.linear.predict_proba(vals)[:, 1] + 0.6 * self.trees.predict_proba(vals)[:, 1]


def usable(panel: pd.DataFrame) -> pd.Series:
    """Rows with every feature filled in and some real trading recently."""
    return panel[FEATURES].notna().all(axis=1) & (panel["traded_share"] > 0)


def training_rows(panel: pd.DataFrame, horizon: str) -> tuple[pd.DataFrame, pd.Series]:
    fwd = panel[f"fwd_{horizon}"]
    mask = usable(panel) & fwd.notna() & (fwd != 0)  # unchanged price = no direction to learn
    X = panel[mask]
    return X, (fwd[mask] > 0).astype(int)


@dataclass
class Signal:
    p_up: float
    action: str        # BUY, SELL or HOLD
    confidence: float  # 0.5 .. 1.0


def to_signal(p_up: float, threshold: float, base_rate: float = 0.5) -> Signal:
    """BUY/SELL only when the chance is clearly above/below what is normal for this horizon.

    Stocks rise a bit more often than they fall, and more so over a month, so a plain 55 percent
    would turn "the market usually goes up" into a BUY on almost everything. The margin is measured
    from the base rate (the share of up moves in the training data) instead of from 50 percent.
    """
    conf = max(p_up, 1 - p_up)
    margin = threshold - 0.5
    if p_up >= base_rate + margin:
        action = "BUY"
    elif p_up <= base_rate - margin:
        action = "SELL"
    else:
        action = "HOLD"
    return Signal(float(p_up), action, float(conf))
