"""Offline tests: no network. Run with  python -m pytest tests"""
from __future__ import annotations

import os
import tempfile

os.environ["PSX_BOT_HOME"] = tempfile.mkdtemp(prefix="psxbot-")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import pytest  # noqa: E402

from psx_bot import HORIZONS, cli, store  # noqa: E402
from psx_bot.config import Settings  # noqa: E402
from psx_bot.features import FEATURES, build_panel  # noqa: E402
from psx_bot.sources import psx, yahoo  # noqa: E402

HIST_HTML = """
<table class="tbl"><thead><tr><th>DATE</th><th>OPEN</th><th>HIGH</th><th>LOW</th><th>CLOSE</th><th>VOLUME</th></tr></thead>
<tbody>
<tr><td>Nov 19, 2026</td><td>270.10</td><td>275.00</td><td>268.50</td><td>273.25</td><td>5,123,400</td></tr>
<tr><td>Nov 18, 2026</td><td>268.00</td><td>271.40</td><td>266.10</td><td>270.05</td><td>4,001,200</td></tr>
<tr><td>Nov 17, 2026</td><td>0.00</td><td>0.00</td><td>0.00</td><td>268.00</td><td>0</td></tr>
<tr><td>bad date</td><td>1</td><td>1</td><td>1</td><td>1</td><td>1</td></tr>
</tbody></table>"""


def test_parse_history_html():
    df = psx.parse_history(HIST_HTML)
    assert list(df.columns) == ["open", "high", "low", "close", "volume"]
    assert len(df) == 3
    assert df.index.is_monotonic_increasing
    assert df.index[-1] == pd.Timestamp("2026-11-19")
    assert df["volume"].iloc[-1] == 5_123_400
    # a close-only row gets open/high/low filled from the close
    assert df.loc["2026-11-17", "open"] == 268.0


REAL_SNIPPET = (
    '<!-- .note(style="margin-bottom: 1rem;")div * Queued order represents cummulative volume --><div class="tbl__wrapper '
    'tbl__wrapper--scrollable"><table class="tbl" id="historicalTable" data-page-length="25"><thead class="tbl__head">'
    '<tr><th data-name="time" data-type="string">DATE </th><th class="right" data-name="open">OPEN</th>'
    '<th class="right">HIGH</th><th class="right">LOW</th><th class="right">CLOSE</th><th class="right">VOLUME</th>'
    '</tr></thead><tbody class="tbl__body"><tr><td data-order="1795172400">Nov 20, 2026</td><td class="right">313.60'
    '</td><td class="right">315.48</td><td class="right">311.91</td><td class="right">313.05</td><td class="right">'
    '1,073,310</td></tr><tr><td data-order="1795086000">Nov 19, 2026</td><td class="right">312.80</td><td class="right">'
    '314.50</td><td class="right">312.01</td><td class="right">312.79</td><td class="right">536,360</td></tr></tbody>'
    '</table></div>')


def test_parse_real_psx_snippet():
    """Copied from a real POST /historical response for OGDC (newest first, commas in volume)."""
    df = psx.parse_history(REAL_SNIPPET)
    assert list(df.index.strftime("%Y-%m-%d")) == ["2026-11-19", "2026-11-20"]
    assert df.loc["2026-11-20", "close"] == 313.05 and df.loc["2026-11-20", "volume"] == 1_073_310


def test_unfinished_day_is_dropped_during_market_hours():
    from datetime import datetime

    df = psx.parse_history(REAL_SNIPPET)
    during = datetime(2026, 11, 20, 11, 0, tzinfo=store.PKT)
    after = datetime(2026, 11, 20, 17, 0, tzinfo=store.PKT)
    assert store.drop_unfinished_day(df, during).index.max() == pd.Timestamp("2026-11-19")
    assert store.drop_unfinished_day(df, after).index.max() == pd.Timestamp("2026-11-20")


def test_parse_history_without_header_row():
    html = "<table><tr><td>19-Nov-2026</td><td>1</td><td>2</td><td>0.5</td><td>1.5</td><td>100</td></tr></table>"
    df = psx.parse_history(html)
    assert df["close"].iloc[0] == 1.5


def test_parse_symbols_and_universe():
    data = [
        {"symbol": "OGDC", "name": "Oil & Gas Development", "sectorName": "OIL & GAS EXPLORATION COMPANIES"},
        {"symbol": "MZNPETF", "name": "Meezan Pakistan ETF", "sectorName": "EXCHANGE TRADED FUNDS", "isETF": True},
        {"symbol": "P01GIS", "name": "GOP Ijara Sukuk", "sectorName": "BILLS AND BONDS", "isDebt": True},
        {"symbol": "XYZ", "name": "Xyz Ltd", "sectorName": "TECHNOLOGY", "isGEM": True},
        {"symbol": "ABCTFC", "name": "ABC TFC 2", "sectorName": "MISC"},
    ]
    df = psx.parse_symbols(data)
    assert set(df.columns) >= {"symbol", "name", "sector", "is_etf", "is_debt", "is_gem"}
    uni = store.universe(df, Settings())
    assert list(uni["symbol"]) == ["OGDC", "XYZ"]
    assert list(store.universe(df, Settings(include_gem=False))["symbol"]) == ["OGDC"]
    assert "MZNPETF" in set(store.universe(df, Settings(include_etfs=True))["symbol"])


def test_token_extraction():
    html = '<script>window.__ps = {"_k":"abcDEF123_-xyz789","v":2};</script>'
    assert psx.extract_token(html) == "abcDEF123_-xyz789"
    assert psx.extract_token("<html></html>") is None


def test_parse_board():
    html = ("<table><tr><th>SYMBOL</th><th>LDCP</th><th>CURRENT</th><th>CHANGE</th><th>VOLUME</th></tr>"
            "<tr><td>OGDC</td><td>270.05</td><td>273.25</td><td>3.20</td><td>5,123,400</td></tr></table>")
    df = psx.parse_board(html)
    assert df.loc[0, "symbol"] == "OGDC" and df.loc[0, "current"] == 273.25


def test_yahoo_parse():
    data = {"chart": {"result": [{"timestamp": [1763520000, 1763606400],
                                  "indicators": {"quote": [{"open": [1, 2], "high": [2, 3], "low": [0.5, 1.5],
                                                            "close": [1.5, 2.5], "volume": [10, 20]}]}}]}}
    df = yahoo.parse_chart(data)
    assert len(df) == 2 and df["close"].iloc[-1] == 2.5


def test_cli_help_has_no_bare_percent():
    """Python 3.14 argparse crashes on '%' in help text; every subcommand's --help must work."""
    parser = cli.build_parser()
    for name in ["update", "scan", "show", "backtest", "score", "gui"]:
        with pytest.raises(SystemExit) as e:
            parser.parse_args([name, "--help"])
        assert e.value.code == 0
    with pytest.raises(SystemExit):
        parser.parse_args(["--help"])


# --- the model on fake prices ------------------------------------------------
def fake_market(n_stocks=40, days=1300, seed=1) -> dict[str, pd.DataFrame]:
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range("2021-09-01", periods=days)
    market = rng.normal(0.0003, 0.01, days)
    out = {}
    for i in range(n_stocks):
        drift = rng.normal(0, 0.0004)
        noise = rng.normal(0, 0.018, days)
        r = drift + market + noise
        # a little short-term momentum so there is something to learn
        r[1:] += 0.15 * r[:-1]
        close = 50 * np.exp(np.cumsum(r)) * (1 + i / 10)
        o = close * np.exp(rng.normal(0, 0.004, days))
        h = np.maximum(o, close) * (1 + np.abs(rng.normal(0, 0.006, days)))
        l = np.minimum(o, close) * (1 - np.abs(rng.normal(0, 0.006, days)))
        v = rng.integers(10_000, 2_000_000, days).astype(float)
        df = pd.DataFrame({"open": o, "high": h, "low": l, "close": close, "volume": v}, index=dates)
        df.index.name = "date"
        if i == 0:  # an illiquid stock with gaps
            df = df.iloc[::3]
        if i == 1:  # a delisted stock: data stops a year ago
            df = df.iloc[:-250]
        out[f"S{i:02d}"] = df
    return out


def test_panel_has_no_lookahead():
    hist = fake_market(8, 400)
    panel, cal = build_panel(hist)
    s = panel.xs("S05", level="symbol")
    # feature on day t must not change if we cut the data after day t
    cut = {k: v[v.index <= cal[300]] for k, v in hist.items()}
    p2, _ = build_panel(cut)
    s2 = p2.xs("S05", level="symbol")
    a = s.loc[cal[300], ["ret_5", "rsi_14", "dist_sma_50", "atr_14", "volume_z"]]
    b = s2.loc[cal[300], ["ret_5", "rsi_14", "dist_sma_50", "atr_14", "volume_z"]]
    assert np.allclose(a.values, b.values, equal_nan=True)
    assert s["fwd_1D"].iloc[-1] != s["fwd_1D"].iloc[-1]  # last day's future is unknown (NaN)
    assert set(FEATURES) <= set(panel.columns)


def _write_fake_store(hist):
    store.HIST_DIR.mkdir(parents=True, exist_ok=True)
    rows = []
    for sym, df in hist.items():
        store._save_history(sym, df)
        rows.append({"symbol": sym, "name": f"{sym} Ltd", "sector": "TEST" if sym < "S20" else "OTHER",
                     "is_etf": False, "is_debt": False, "is_gem": False})
    pd.DataFrame(rows).to_csv(store.SYMBOLS_FILE, index=False)


def test_scan_and_backtest_end_to_end():
    from psx_bot.backtest import report_text, walk_forward
    from psx_bot.report import scan_text, stock_text
    from psx_bot.signals import load_scan, run_scan

    hist = fake_market()
    _write_fake_store(hist)
    settings = Settings(min_turnover=1_000_000)
    scan = run_scan(settings, progress=lambda m: None, fast=True)
    t = scan.table
    assert "S01" not in t.index          # delisted stock is left out
    assert len(t) >= 30
    for hz in HORIZONS:
        assert t[f"p_{hz}"].between(0, 1).all()
        assert set(t[f"sig_{hz}"]) <= {"BUY", "SELL", "HOLD"}
        buy = t[t[f"p_{hz}"] >= 0.5]
        assert (buy[f"tp_{hz}"] > buy["close"]).all() and (buy[f"sl_{hz}"] < buy["close"]).all()
    again = load_scan()
    assert again is not None and again.as_of == scan.as_of and len(again.table) == len(t)
    assert "PSX signals" in scan_text(again)
    assert "S05" in stock_text(again, "S05", hist["S05"])

    results = walk_forward(settings, progress=lambda m: None, fast=True, step=200)
    assert [r.horizon for r in results] == list(HORIZONS)
    for r in results:
        assert 0.3 < r.accuracy < 0.8
        assert r.predictions > 1000
    text = report_text(results, settings)
    assert "BUY calls" in text and "By year" in text
    rec = pd.read_csv(store.DATA_DIR.parent / "logs" / "backtest_stocks.csv", index_col="symbol")
    assert "bt_hit_1W" in rec.columns
