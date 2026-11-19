"""The prediction model: a blend of logistic regression and gradient-boosted trees.

Each timeframe gets its own model, retrained on the latest candles every time it predicts.
Output is the probability that the next candle closes higher than the last closed one.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .features import build_features, build_target


class MovementModel:
    def __init__(self, random_state: int = 7):
        self.linear = make_pipeline(StandardScaler(), LogisticRegression(C=0.1, max_iter=500))
        self.trees = HistGradientBoostingClassifier(
            max_depth=2, learning_rate=0.03, max_iter=100, min_samples_leaf=150,
            l2_regularization=5.0, random_state=random_state)
        self.columns: list[str] = []
        self.fitted = False

    def fit(self, X: pd.DataFrame, y: pd.Series) -> "MovementModel":
        self.columns = list(X.columns)
        if y.nunique() < 2:
            raise ValueError("Training data only moves one way; need more history")
        self.linear.fit(X.values, y.values)
        self.trees.fit(X.values, y.values)
        self.fitted = True
        return self

    def predict_up_proba(self, X: pd.DataFrame) -> np.ndarray:
        vals = X[self.columns].values
        p_lin = self.linear.predict_proba(vals)[:, 1]
        p_tree = self.trees.predict_proba(vals)[:, 1]
        return 0.6 * p_lin + 0.4 * p_tree


def training_frame(candles: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series, pd.DataFrame]:
    """Features+target for rows that have both, and the feature rows (incl. the latest) for predicting."""
    feats = build_features(candles)
    target = build_target(candles)
    usable = feats.notna().all(axis=1)
    train_mask = usable & target.notna()
    return feats[train_mask], target[train_mask], feats[usable]


@dataclass
class Signal:
    p_up: float
    direction: str  # UP, DOWN or NEUTRAL
    confidence: float  # 0.5 .. 1.0


def to_signal(p_up: float, threshold: float) -> Signal:
    conf = max(p_up, 1 - p_up)
    if conf < threshold:
        direction = "NEUTRAL"
    else:
        direction = "UP" if p_up > 0.5 else "DOWN"
    return Signal(p_up=float(p_up), direction=direction, confidence=float(conf))
