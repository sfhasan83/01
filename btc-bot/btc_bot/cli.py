"""Command line entry point:  python -m btc_bot <command>"""
from __future__ import annotations

import argparse
import os
import sys
import time

from . import TIMEFRAMES
from .config import Settings, coin_name


def _console_utf8():
    # Windows consoles default to an old code page; make arrows and symbols print correctly
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass


def cmd_predict(settings: Settings, args) -> None:
    from .predictor import take_snapshot
    from .report import snapshot_text

    print(snapshot_text(take_snapshot(settings, args.timeframes)))


def cmd_watch(settings: Settings, args) -> None:
    from .predictor import take_snapshot
    from .report import snapshot_text

    while True:
        try:
            text = snapshot_text(take_snapshot(settings, args.timeframes))
        except Exception as err:  # noqa: BLE001
            text = f"Refresh failed: {err}"
        os.system("cls" if os.name == "nt" else "clear")
        print(text)
        print(f"\nRefreshing every {settings.refresh_seconds}s. Press Ctrl+C to stop.")
        try:
            time.sleep(settings.refresh_seconds)
        except KeyboardInterrupt:
            break


def cmd_backtest(settings: Settings, args) -> None:
    from .backtest import format_result, walk_forward
    from .predictor import load_candles

    candles_needed = max(settings.history_candles, args.candles)
    print("Running walk-forward backtest. This downloads history and can take a minute...\n")
    for sym in settings.symbols:
        for tf in args.timeframes:
            name = f"{coin_name(sym)} {tf}"
            try:
                candles, source = load_candles(settings, tf, total=candles_needed, symbol=sym)
                res = walk_forward(candles, name, settings.confidence_threshold, settings.fee_rate,
                                  sl_mult=settings.sl_atr_mult, tp_mult=settings.tp_atr_mult,
                                  tp_sl_candles=settings.tp_sl_candles)
                print(format_result(res) + f"\n  (data: {source})\n")
            except Exception as err:  # noqa: BLE001
                print(f"== {name}: backtest failed: {err}\n")
    print("Above 50% is not enough: it must beat the simple rules AND survive fees to be useful.")


def cmd_score(settings: Settings, args) -> None:
    from .predictor import PREDICTION_LOG, score_log

    table = score_log(settings)
    if table.empty:
        print(f"No finished predictions to check yet. Run predict/watch first (log: {PREDICTION_LOG}).")
        return
    print("Live track record of logged predictions (one per candle):\n")
    print(table.to_string(index=False, float_format=lambda x: f"{x:.1%}"))


def cmd_webhook(settings: Settings, args) -> None:
    from .webhook import serve

    serve(settings)


def cmd_gui(settings: Settings, args) -> None:
    from .gui import run

    run(settings)


def main(argv=None) -> None:
    _console_utf8()
    parser = argparse.ArgumentParser(prog="btc_bot", description="Crypto short-term movement predictor (signals only)")
    sub = parser.add_subparsers(dest="command")
    tf_help = "Timeframes to use (default: 5m 15m 1h)"
    for name, fn, help_text in [
        ("predict", cmd_predict, "Show one forecast and exit"),
        ("watch", cmd_watch, "Keep refreshing the forecast in this window"),
        ("backtest", cmd_backtest, "Measure past accuracy honestly (walk-forward)"),
        ("score", cmd_score, "Check how logged live predictions actually turned out"),
        ("webhook", cmd_webhook, "Receive TradingView webhook alerts"),
        ("gui", cmd_gui, "Open the desktop window"),
    ]:
        p = sub.add_parser(name, help=help_text)
        p.set_defaults(func=fn)
        if name in ("predict", "watch", "backtest"):
            p.add_argument("--timeframes", nargs="+", choices=TIMEFRAMES, default=list(TIMEFRAMES), help=tf_help)
        if name == "backtest":
            p.add_argument("--candles", type=int, default=5000, help="Candles of history per timeframe (default 5000)")
    for p in sub.choices.values():
        p.add_argument("--coins", nargs="+", metavar="SYMBOL",
                       help="Override SYMBOLS from .env, e.g. --coins BTCUSDT SOLUSDT")
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        args = parser.parse_args(["gui"])
    settings = Settings.load()
    if args.coins:
        settings.symbols = [c.upper() for c in args.coins]
    args.func(settings, args)
