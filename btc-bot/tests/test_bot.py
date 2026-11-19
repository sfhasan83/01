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
            assert params["symbol"] == "BTC,ETH,SOL"
            return {"data": {"BTC": [{"quote": {"USD": {"price": 90000, "percent_change_1h": 0.2,
                                                        "percent_change_24h": -1.1, "volume_24h": 1e10}}}],
                             "ETH": {"quote": {"USD": {"price": 3000}}},
                             "SOL": [{"quote": {"USD": {"price": 150}}}]}}
        if "global-metrics" in url:
            return {"data": {"btc_dominance": 58.1, "quote": {"USD": {}}}}
        return {"data": {"value": 40, "value_classification": "Fear"}}
    monkeypatch.setattr(coinmarketcap, "get_json", fake)
    monkeypatch.setattr(coinmarketcap, "_cache", {})
    ctx = coinmarketcap.fetch_context("key", ["BTC", "ETH", "SOL"])
    assert ctx.coins["BTC"].price == 90000 and ctx.coins["SOL"].price == 150 and ctx.btc_dominance == 58.1 and ctx.fear_greed_label == "Fear" and not ctx.error
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
    seeds = {"BTCUSDT": 1, "ETHUSDT": 2, "SOLUSDT": 3}
    monkeypatch.setattr(mexc, "fetch_klines",
                        lambda s, tf, n: rows_to_frame(synthetic_rows(n, steps[tf], seed=seeds[s])))
    monkeypatch.setattr(mexc, "fetch_price", lambda s: 61000.0)
    monkeypatch.setattr(predictor.tradingview, "fetch_rating",
                        lambda s, tf: predictor.tradingview.TVRating(recommendation="BUY"))
    monkeypatch.setattr(predictor.tradingview, "prefetch", lambda symbols, tf: None)
    snap = predictor.take_snapshot(Settings(history_candles=800))
    assert [(p.coin, p.timeframe) for p in snap.predictions] == [
        (c, tf) for c in ("BTC", "ETH", "SOL") for tf in ("5m", "15m", "1h")]
    assert all(p.signal and p.source == "mexc" for p in snap.predictions)
    assert (tmp_path / "p.csv").exists()
    from btc_bot.report import snapshot_text
    text = snapshot_text(snap)
    assert ("LONG ▲" in text or "SHORT ▼" in text) and "Prediction" in text
    assert "Take profit $" in text and "Stop loss $" in text
    p0 = snap.predictions[0]
    assert (p0.take_profit > p0.last_close > p0.stop_loss) if p0.side == "LONG" else \
        (p0.take_profit < p0.last_close < p0.stop_loss)
    assert "MEXC: $61,000.00" in text and "SOL " in text and "ETH " in text
    import csv
    rows = list(csv.DictReader((tmp_path / "p.csv").open()))
    assert {r["symbol"] for r in rows} == {"BTCUSDT", "ETHUSDT", "SOLUSDT"}
    print(text)


def test_webhook_store(monkeypatch, tmp_path):
    from btc_bot.sources import tradingview
    monkeypatch.setattr(webhook, "LOG_DIR", tmp_path)
    monkeypatch.setattr(webhook, "ALERTS_FILE", tmp_path / "a.json")
    monkeypatch.setattr(tradingview, "ALERTS_FILE", tmp_path / "a.json")
    webhook.store_alert({"timeframe": "15", "action": "SELL", "price": 1})
    assert json.loads((tmp_path / "a.json").read_text())["BTCUSDT|15m"]["action"] == "sell"


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
    assert post({"secret": "s3cret", "symbol": "BINANCE:SOLUSDT", "timeframe": "5", "action": "buy"}) == 200
    srv.shutdown()
    assert tradingview.latest_alerts()["SOLUSDT|5m"]["action"] == "buy"


def test_score_log(monkeypatch, tmp_path):
    monkeypatch.setattr(predictor, "LOG_DIR", tmp_path)
    monkeypatch.setattr(predictor, "PREDICTION_LOG", tmp_path / "p.csv")
    df = rows_to_frame(synthetic_rows(1000))
    monkeypatch.setattr(predictor, "load_candles", lambda s, tf, total=None, symbol=None: (df, "binance"))
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
        expected.append((direction, went_up == (p_up > 0.5)))
    (tmp_path / "p.csv").write_text("\n".join(lines) + "\n")
    # with only 15 candles, the last two calls have not closed yet and must not be counted
    res = predictor.signal_results(predictor.check_signals(predictor._read_log(), "5m", df.iloc[:15]))
    strong = [hit for d, hit in expected if d != "NEUTRAL"]
    assert res.checked == 3 and res.hits == sum(strong[:3])
    assert res.all_checked == 4 and res.all_hits == sum(hit for _, hit in expected[:4])
    res = predictor.signal_results(predictor.check_signals(predictor._read_log(), "5m", df))
    assert res.checked == 4 and res.hits == sum(strong)
    assert res.all_checked == 6 and res.all_hits == sum(hit for _, hit in expected)
    # the last row was NEUTRAL (p_up 0.52): it is still scored, by its UP lean, and labelled as a lean
    assert res.last_is_lean and res.last_direction == "UP" and res.last_hit == expected[-1][1]
    assert signal_badge(res) == ("YES ✔ HIT (lean)" if expected[-1][1] else "NO ✘ MISSED (lean)")
    assert "Hit rate: signals" in result_line(res)
    assert signal_badge(predictor.SignalResults()) == "waiting"


def test_old_btc_log_is_upgraded(monkeypatch, tmp_path):
    """A log from the BTC-only version keeps counting as BTC after ETH and SOL are added."""
    monkeypatch.setattr(predictor, "LOG_DIR", tmp_path)
    monkeypatch.setattr(predictor, "PREDICTION_LOG", tmp_path / "p.csv")
    old = ("created_utc,timeframe,source,last_close_time_utc,target_close_time_utc,last_close,p_up,"
           "direction,confidence,tv_recommendation\n"
           "2026-01-01T00:00:00+00:00,5m,binance,2026-01-01T00:00:00+00:00,2026-01-01T00:05:00+00:00,"
           "60000,0.6,UP,0.6,\n")
    (tmp_path / "p.csv").write_text(old)
    assert set(predictor._read_log()["symbol"]) == {"BTCUSDT"}
    sig = model.to_signal(0.3, 0.58)
    t = pd.Timestamp("2026-01-01T00:05:00", tz="UTC")
    pred = predictor.TimeframePrediction("5m", sig, 150.0, t, t + pd.Timedelta(minutes=5), "binance",
                                         predictor.tradingview.TVRating(), symbol="SOLUSDT")
    predictor.log_snapshot(predictor.Snapshot(created=t.to_pydatetime(), predictions=[pred]))
    log = predictor._read_log()
    assert list(log.sort_values("created_utc")["symbol"]) == ["BTCUSDT", "SOLUSDT"]
    assert (tmp_path / "p.csv").read_text().splitlines()[0].endswith(",symbol,tp,sl")


def test_coin_name_and_settings(monkeypatch):
    from btc_bot.config import coin_name
    assert coin_name("SOLUSDT") == "SOL" and coin_name("ETHUSDC") == "ETH"
    monkeypatch.setenv("SYMBOLS", "btcusdt, solusdt")
    assert Settings.load().symbols == ["BTCUSDT", "SOLUSDT"]
    monkeypatch.delenv("SYMBOLS")
    assert Settings.load().symbols == ["BTCUSDT", "ETHUSDT", "SOLUSDT"]


def test_tradingview_batches_and_backs_off(monkeypatch):
    import sys
    import types

    from btc_bot.sources import tradingview as tv
    monkeypatch.setattr(tv, "_cache", {})
    monkeypatch.setattr(tv, "_blocked_until", {})
    monkeypatch.setattr(tv, "_last_error", {})
    calls = []
    state = {"fail": False}

    def fake_multi(screener, interval, symbols, timeout=None):
        calls.append(list(symbols))
        if state["fail"]:
            raise Exception("Can't access TradingView's API. HTTP status code: 429.")
        return {s: types.SimpleNamespace(summary={"RECOMMENDATION": "BUY", "BUY": 10, "SELL": 2, "NEUTRAL": 5})
                for s in symbols}
    fake_mod = types.SimpleNamespace(get_multiple_analysis=fake_multi,
                                     Interval=types.SimpleNamespace(INTERVAL_5_MINUTES="5m",
                                                                    INTERVAL_15_MINUTES="15m",
                                                                    INTERVAL_1_HOUR="1h"))
    monkeypatch.setitem(sys.modules, "tradingview_ta", fake_mod)
    syms = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
    tv.prefetch(syms, "5m")
    assert calls == [["BINANCE:BTCUSDT", "BINANCE:ETHUSDT", "BINANCE:SOLUSDT"]]
    assert all(tv.fetch_rating(s, "5m").recommendation == "BUY" for s in syms)
    assert len(calls) == 1  # served from cache
    # a 429 keeps showing the last good rating and pauses requests
    for key in list(tv._cache):
        tv._cache[key].fetched -= 1000
    state["fail"] = True
    assert tv.fetch_rating("BTCUSDT", "5m").recommendation == "BUY"
    n = len(calls)
    tv.prefetch(syms, "5m")
    assert len(calls) == n  # backing off
    tv._cache.clear()
    assert "429" in tv.fetch_rating("BTCUSDT", "5m").error


def test_tradingview_empty_answer_backs_off(monkeypatch):
    import sys
    import types

    from btc_bot.sources import tradingview as tv
    for name in ("_cache", "_blocked_until", "_last_error"):
        monkeypatch.setattr(tv, name, {})
    calls = []

    def fake_multi(screener, interval, symbols, timeout=None):
        calls.append(1)
        raise ValueError("Expecting value: line 1 column 1 (char 0)")
    monkeypatch.setitem(sys.modules, "tradingview_ta", types.SimpleNamespace(
        get_multiple_analysis=fake_multi, Interval=types.SimpleNamespace(
            INTERVAL_5_MINUTES="5m", INTERVAL_15_MINUTES="15m", INTERVAL_1_HOUR="1h")))
    err = tv.fetch_rating("BTCUSDT", "5m").error
    assert "empty answer" in err and "10 minutes" in err
    tv.fetch_rating("ETHUSDT", "5m")
    assert len(calls) == 1


def test_tpsl_levels_and_outcomes():
    from btc_bot import tpsl
    tp, sl = tpsl.levels(100.0, "LONG", 2.0, 1.0, 1.5)
    assert (tp, sl) == (103.0, 98.0)
    tp, sl = tpsl.levels(100.0, "SHORT", 2.0, 1.0, 1.5)
    assert (tp, sl) == (97.0, 102.0)
    idx = pd.date_range("2026-01-01", periods=3, freq="5min", tz="UTC")

    def candles(rows):
        return pd.DataFrame(rows, columns=["open", "high", "low", "close"], index=idx[:len(rows)])
    # LONG: TP touched in the 2nd candle
    assert tpsl.outcome("LONG", 103, 98, candles([[100, 101, 99, 100.5], [100.5, 103.5, 100, 103]]), 3) == ("TP", 103)
    # both touched in one candle: counted as SL (cautious)
    assert tpsl.outcome("LONG", 103, 98, candles([[100, 104, 97, 100]]), 3) == ("SL", 98)
    # SHORT: SL touched
    assert tpsl.outcome("SHORT", 97, 102, candles([[100, 102.5, 99, 101]]), 3) == ("SL", 102)
    # nothing touched within 2 candles -> expired at the 2nd close
    assert tpsl.outcome("LONG", 103, 98, candles([[100, 101, 99, 100], [100, 101, 99, 100.7], [1, 1, 1, 1]]), 2) \
        == ("EXPIRED", 100.7)
    # not enough candles yet -> still open
    assert tpsl.outcome("LONG", 103, 98, candles([[100, 101, 99, 100]]), 3) == ("OPEN", None)
    assert tpsl.r_multiple("LONG", 100, 98, 103) == 1.5 and tpsl.r_multiple("SHORT", 100, 102, 102) == -1


def test_tpsl_evaluate_live_log():
    from btc_bot import tpsl
    idx = pd.date_range("2026-01-01", periods=4, freq="5min", tz="UTC")
    candles = pd.DataFrame({"open": [100, 100, 101, 99], "high": [101, 101.5, 103.5, 99.5],
                            "low": [99, 99.5, 100.5, 96], "close": [100, 101, 103, 97]}, index=idx)
    log = pd.DataFrame({
        "last_close_time_utc": [idx[1], idx[1], idx[3]],
        "last_close": [100, 100, 101],
        "p_up": [0.6, 0.4, 0.6],
        "tp": [103, 97, 104], "sl": [98, 102, 99],
    })
    res = tpsl.evaluate(log, candles, 2)
    # LONG from idx1: candle1 ok, candle2 high 103.5 -> TP. SHORT from idx1: candle2 high 103.5 -> SL.
    # LONG from idx3: low 96 -> SL? only one candle and it hits SL
    assert (res.tp, res.sl, res.expired, res.open) == (1, 2, 0, 0)
    assert res.last_outcome == "SL" and abs(res.total_r - (1.5 - 1 - 1)) < 1e-9


def test_backtest_reports_tpsl():
    df = rows_to_frame(synthetic_rows(2400))
    r = backtest.walk_forward(df, "5m", threshold=0.55, train_size=1500, step=200)
    assert r.tpsl["trades"] > 0 and r.tpsl["TP"] + r.tpsl["SL"] + r.tpsl["EXPIRED"] == r.tpsl["trades"]
    assert "TP/SL on confident calls" in backtest.format_result(r)


def _planted_swing_hours(days=800, hours_utc=(1, 8, 13), seed=0):
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2022-01-01", periods=24 * days, freq="1h", tz="UTC")
    r = rng.normal(0, 0.004, len(idx))
    for h in hours_utc:  # a sharp move into the hour, reversed straight after: a planted swing
        m = (idx.hour == h) & (rng.random(len(idx)) < 0.5)
        sign = rng.choice([-1, 1], len(idx))
        r[m] += sign[m] * 0.02
        after = np.roll(m, 1)
        r[after] -= np.roll(sign, 1)[after] * 0.025
    c = 60000 * np.exp(np.cumsum(r))
    o = np.r_[c[0], c[:-1]]
    return pd.DataFrame({"open": o, "close": c, "high": np.maximum(o, c) * 1.001,
                         "low": np.minimum(o, c) * 0.999, "volume": 1.0}, index=idx)


def test_swing_study_finds_planted_hours_in_local_time():
    from datetime import timedelta, timezone

    from btc_bot import swings
    res = swings.study(_planted_swing_hours(), "BTCUSDT", tz=timezone(timedelta(hours=4)))
    found = sorted(w.hour for w in res.windows)
    # planted at UTC 01, 08, 13 (+ the reversal hour) -> Dubai 05/06, 12/13, 17/18
    assert all(any(h in (t, t + 1) for h in found) for t in (5, 12, 17)), found
    assert res.test_year_in_windows > res.test_chance * 1.5
    assert res.tz_label == "UTC+04:00"
    text = swings.report_text([res])
    assert "Window 1" in text and "Honesty check" in text


def test_swing_study_on_noise_says_no_pattern():
    from datetime import timedelta, timezone

    from btc_bot import swings
    res = swings.study(_planted_swing_hours(hours_utc=()), "ETHUSDT", tz=timezone(timedelta(hours=4)))
    assert any("NOT" in n or "shifts" in n for n in res.notes)


def test_next_swing_window_text():
    from datetime import datetime, timedelta, timezone

    from btc_bot import swings
    tz = timezone(timedelta(hours=4))
    data = {"coins": [{"symbol": "BTCUSDT", "windows": [{"hour": 17}, {"hour": 5}]},
                      {"symbol": "SOLUSDT", "windows": [{"hour": 17}]}]}
    now = datetime(2026, 11, 19, 16, 40, tzinfo=tz)
    text = swings.next_window_text(data, now)
    assert text.startswith("Next swing window: 17:00-18:00 (in 20 min) for BTC/SOL")
    assert "NOW" in swings.next_window_text(data, datetime(2026, 11, 19, 17, 10, tzinfo=tz))
    assert "not calculated" in swings.next_window_text(None)


def test_history_cache_only_fetches_new_candles(monkeypatch, tmp_path):
    from btc_bot import swings
    monkeypatch.setattr(swings, "HISTORY_DIR", tmp_path)
    full = _planted_swing_hours(days=40)
    now = full.index[-1] + pd.Timedelta(hours=1)
    monkeypatch.setattr(swings, "drop_unfinished", lambda df, tf: df)
    calls = []

    def fake_since(symbol, interval, start_ms, progress=None):
        calls.append(start_ms)
        return full[full.index >= pd.Timestamp(start_ms, unit="ms", tz="UTC")]
    monkeypatch.setattr(swings.binance, "fetch_klines_since", fake_since)
    monkeypatch.setattr(pd.Timestamp, "now", classmethod(lambda cls, tz=None: now))
    first = swings.load_history("BTCUSDT", years=0.1)
    assert len(first) > 800 and (tmp_path / "BTCUSDT_1h.csv").exists()
    second = swings.load_history("BTCUSDT", years=0.1)
    assert calls[1] > calls[0] and len(second) == len(first)
