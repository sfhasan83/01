"""Offline tests: synthetic candles and mocked APIs, no network needed."""
import json

import numpy as np
import pandas as pd

from btc_bot import backtest, features, model, predictor, webhook
from btc_bot.config import Settings
from btc_bot.sources import binance, coinmarketcap, drop_unfinished, mexc, rows_to_frame


def synthetic_rows(n=3000, step_ms=300_000, seed=1, drift=0.0):
    rng = np.random.default_rng(seed)
    t0 = int(pd.Timestamp("2026-01-01", tz="UTC").value // 1_000_000)
    price, rows = 60000.0, []
    for i in range(n):
        o = price
        price = price * float(np.exp(rng.normal(drift, 0.002)))
        h, lo = max(o, price) * 1.001, min(o, price) * 0.999
        rows.append([t0 + i * step_ms, str(o), str(h), str(lo), str(price), str(rng.uniform(5, 50)),
                     t0 + (i + 1) * step_ms - 1])
    return rows


def test_rows_to_frame_and_drop_unfinished():
    df = rows_to_frame(synthetic_rows(10))
    assert list(df.columns)[:5] == ["open", "high", "low", "close", "volume"]
    now = df.index[-1] + pd.Timedelta(minutes=2)  # last candle still forming
    assert len(drop_unfinished(df, "5m", now)) == 9


def test_features_have_no_lookahead():
    df = rows_to_frame(synthetic_rows(400))
    full = features.build_features(df)
    cut = features.build_features(df.iloc[:300])
    pd.testing.assert_frame_equal(full.iloc[:300], cut)


def test_target():
    df = pd.DataFrame({"close": [1.0, 2.0, 1.5]})
    t = features.build_target(df)
    assert t.iloc[0] == 1 and t.iloc[1] == 0 and np.isnan(t.iloc[2])


def test_random_walk_backtest_shows_no_edge():
    df = rows_to_frame(synthetic_rows(2400))
    r = backtest.walk_forward(df, "5m", train_size=1500, step=200)
    assert r.n_predictions > 500
    assert 0.44 < r.accuracy < 0.56  # pure noise must not look predictable
    assert r.notes  # and the report must say so
    print(backtest.format_result(r))


def test_learns_a_real_pattern():
    # Make the next move depend on RSI-like behaviour: strong mean reversion
    rng = np.random.default_rng(3)
    rets = np.zeros(2600)
    for i in range(1, 2600):
        rets[i] = -0.6 * rets[i - 1] + rng.normal(0, 0.002)
    close = 60000 * np.exp(np.cumsum(rets))
    idx = pd.date_range("2026-01-01", periods=2600, freq="5min", tz="UTC")
    df = pd.DataFrame({"open": np.r_[close[0], close[:-1]], "close": close, "volume": 10.0}, index=idx)
    df["high"] = df[["open", "close"]].max(axis=1) * 1.0005
    df["low"] = df[["open", "close"]].min(axis=1) * 0.9995
    r = backtest.walk_forward(df, "5m", train_size=1500, step=200)
    assert r.accuracy > 0.6


def test_signal_threshold():
    assert model.to_signal(0.52, 0.55).direction == "NEUTRAL"
    assert model.to_signal(0.60, 0.55).direction == "UP"
    assert model.to_signal(0.30, 0.55).direction == "DOWN"


def test_binance_pagination(monkeypatch):
    rows = synthetic_rows(2500)
    calls = []

    def fake(url, params=None, headers=None):
        calls.append(params)
        end = params.get("endTime", 10 ** 15)
        avail = [r for r in rows if r[0] <= end]
        return avail[-params["limit"]:]
    monkeypatch.setattr(binance, "get_json", fake)
    df = binance.fetch_klines("BTCUSDT", "5m", 2500)
    assert len(df) == 2500 and df.index.is_monotonic_increasing and len(calls) == 3


def test_mexc_uses_60m(monkeypatch):
    seen = {}

    def fake(url, params=None, headers=None):
        seen.update(params)
        return synthetic_rows(10, step_ms=3_600_000)
    monkeypatch.setattr(mexc, "get_json", fake)
    mexc.fetch_klines("BTCUSDT", "1h", 10)
    assert seen["interval"] == "60m"


def test_cmc_parsing(monkeypatch):
    def fake(url, params=None, headers=None):
        if "quotes/latest" in url and "cryptocurrency" in url:
            return {"data": {"BTC": [{"quote": {"USD": {"price": 90000, "percent_change_1h": 0.2,
                                                        "percent_change_24h": -1.1, "volume_24h": 1e10}}}]}}
        if "global-metrics" in url:
            return {"data": {"btc_dominance": 58.1, "quote": {"USD": {}}}}
        return {"data": {"value": 40, "value_classification": "Fear"}}
    monkeypatch.setattr(coinmarketcap, "get_json", fake)
    monkeypatch.setattr(coinmarketcap, "_cache", {})
    ctx = coinmarketcap.fetch_context("key")
    assert ctx.price == 90000 and ctx.btc_dominance == 58.1 and ctx.fear_greed_label == "Fear" and not ctx.error
    assert coinmarketcap.fetch_context("").error


def test_full_snapshot_with_fallback(monkeypatch, tmp_path):
    monkeypatch.setattr(predictor, "LOG_DIR", tmp_path)
    monkeypatch.setattr(predictor, "PREDICTION_LOG", tmp_path / "p.csv")
    monkeypatch.setattr(predictor.tradingview, "ALERTS_FILE", tmp_path / "a.json")
    steps = {"5m": 300_000, "15m": 900_000, "1h": 3_600_000}

    def broken(*a, **k):
        raise ConnectionError("blocked")
    monkeypatch.setattr(binance, "fetch_klines", broken)
    monkeypatch.setattr(binance, "fetch_price", broken)
    monkeypatch.setattr(mexc, "fetch_klines", lambda s, tf, n: rows_to_frame(synthetic_rows(n, steps[tf])))
    monkeypatch.setattr(mexc, "fetch_price", lambda s: 61000.0)
    monkeypatch.setattr(predictor.tradingview, "fetch_rating",
                        lambda s, tf: predictor.tradingview.TVRating(recommendation="BUY"))
    snap = predictor.take_snapshot(Settings(history_candles=800))
    assert [p.timeframe for p in snap.predictions] == ["5m", "15m", "1h"]
    assert all(p.signal and p.source == "mexc" for p in snap.predictions)
    assert (tmp_path / "p.csv").exists()
    from btc_bot.report import snapshot_text
    text = snapshot_text(snap)
    assert "MEXC: $61,000.00" in text
    print(text)


def test_webhook_store(monkeypatch, tmp_path):
    from btc_bot.sources import tradingview
    monkeypatch.setattr(webhook, "LOG_DIR", tmp_path)
    monkeypatch.setattr(webhook, "ALERTS_FILE", tmp_path / "a.json")
    monkeypatch.setattr(tradingview, "ALERTS_FILE", tmp_path / "a.json")
    webhook.store_alert({"timeframe": "15", "action": "SELL", "price": 1})
    assert json.loads((tmp_path / "a.json").read_text())["15m"]["action"] == "sell"


def test_webhook_http_roundtrip(monkeypatch, tmp_path):
    import threading
    import urllib.request
    from http.server import ThreadingHTTPServer

    from btc_bot.sources import tradingview
    for mod in (webhook, tradingview):
        monkeypatch.setattr(mod, "ALERTS_FILE", tmp_path / "a.json")
    monkeypatch.setattr(webhook, "LOG_DIR", tmp_path)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), webhook.make_handler("s3cret"))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}/tradingview"

    def post(body):
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST")
        try:
            return urllib.request.urlopen(req).status
        except urllib.error.HTTPError as e:
            return e.code
    assert post({"secret": "wrong", "timeframe": "5", "action": "buy"}) == 403
    assert post({"secret": "s3cret", "timeframe": "5", "action": "buy"}) == 200
    srv.shutdown()
    assert tradingview.latest_alerts()["5m"]["action"] == "buy"


def test_score_log(monkeypatch, tmp_path):
    monkeypatch.setattr(predictor, "LOG_DIR", tmp_path)
    monkeypatch.setattr(predictor, "PREDICTION_LOG", tmp_path / "p.csv")
    df = rows_to_frame(synthetic_rows(1000))
    monkeypatch.setattr(predictor, "load_candles", lambda s, tf, total=None: (df, "binance"))
    step = pd.Timedelta(minutes=5)
    lines = ["created_utc,timeframe,source,last_close_time_utc,target_close_time_utc,last_close,p_up,"
             "direction,confidence,tv_recommendation"]
    for i in range(900, 950):
        t = df.index[i]
        lines.append(f"{t.isoformat()},5m,binance,{(t + step).isoformat()},{(t + 2 * step).isoformat()},"
                     f"{df['close'].iloc[i]},0.6,UP,0.6,BUY")
    (tmp_path / "p.csv").write_text("\n".join(lines) + "\n")
    table = predictor.score_log(Settings())
    up_share = (df["close"].iloc[901:951].values > df["close"].iloc[900:950].values).mean()
    assert table.iloc[0]["checked"] == 50
    assert abs(table.iloc[0]["accuracy"] - up_share) < 1e-9


def test_signal_hit_results(monkeypatch, tmp_path):
    from btc_bot.report import result_line, signal_badge
    monkeypatch.setattr(predictor, "PREDICTION_LOG", tmp_path / "p.csv")
    df = rows_to_frame(synthetic_rows(50))
    step = pd.Timedelta(minutes=5)
    header = ("created_utc,timeframe,source,last_close_time_utc,target_close_time_utc,last_close,p_up,"
              "direction,confidence,tv_recommendation")
    lines, expected = [header], []
    for i, (p_up, direction) in zip(range(10, 16), [(0.7, "UP"), (0.3, "DOWN"), (0.52, "NEUTRAL"),
                                                     (0.7, "UP"), (0.3, "DOWN"), (0.52, "NEUTRAL")]):
        t = df.index[i]
        lines.append(f"{t.isoformat()},5m,binance,{(t + step).isoformat()},{(t + 2 * step).isoformat()},"
                     f"{df['close'].iloc[i]},{p_up},{direction},0.6,")
        # a repeated, later call for the same candle must be ignored
        lines.append(f"{(t + pd.Timedelta(minutes=1)).isoformat()},5m,binance,{(t + step).isoformat()},"
                     f"{(t + 2 * step).isoformat()},{df['close'].iloc[i]},{1 - p_up},UP,0.6,")
        went_up = df["close"].iloc[i + 1] > df["close"].iloc[i]
        if direction != "NEUTRAL":
            expected.append(went_up == (direction == "UP"))
    (tmp_path / "p.csv").write_text("\n".join(lines) + "\n")
    # a 6th call whose candle has not closed yet must not be counted
    res = predictor.signal_results(predictor.check_signals(predictor._read_log(), "5m", df.iloc[:15]))
    assert res.checked == 3 and res.hits == sum(expected[:3])
    res = predictor.signal_results(predictor.check_signals(predictor._read_log(), "5m", df))
    assert res.checked == 4 and res.hits == sum(expected)
    assert res.last_hit == expected[-1] and res.last_direction == "DOWN"
    assert signal_badge(res) == ("YES ✔ HIT" if expected[-1] else "NO ✘ MISSED")
    assert "Hit rate" in result_line(res)
    assert signal_badge(predictor.SignalResults()) == "waiting"
