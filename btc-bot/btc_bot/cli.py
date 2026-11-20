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


def cmd_swings(settings: Settings, args) -> None:
    from .swings import report_text, run_study

    print("Studying swing times. The first run downloads 5 years of hourly prices per coin (a few minutes).\n")
    results = run_study(settings, years=args.years)
    print()
    print(report_text(results))


def cmd_bigmoves(settings: Settings, args) -> None:
    from .bigmoves import report_text

    print(report_text(settings.big_move_pct))


def cmd_webhook(settings: Settings, args) -> None:
    from .webhook import serve

    serve(settings)


def cmd_gui(settings: Settings, args) -> None:
    from .gui import run

    run(settings)


def _windowless() -> bool:
    """True when started by pythonw.exe (the desktop icon): there is no console, so errors are invisible."""
    return sys.stdout is None or sys.stderr is None


def _show_startup_error(text: str) -> None:
    """Write the error to logs\\startup-error.log and show it in a message box, so a failed start is never silent."""
    from .config import LOG_DIR

    log = LOG_DIR / "startup-error.log"
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        log.write_text(text, encoding="utf-8")
    except OSError:
        pass
    msg = ("Crypto Movement Bot could not start.\n\n" + text[-1500:] +
           f"\n\nThis message was saved to:\n{log}\n\n"
           "Tip: run start-gui-debug.bat in the bot folder to see the full details, "
           "or run setup.bat again to repair the installation.")
    try:
        import ctypes  # works even when tkinter itself is what failed

        ctypes.windll.user32.MessageBoxW(None, msg, "Crypto Movement Bot", 0x10)
        return
    except Exception:  # noqa: BLE001 - not Windows
        pass
    try:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.withdraw()
        messagebox.showerror("Crypto Movement Bot", msg)
        root.destroy()
    except Exception:  # noqa: BLE001
        pass


def main(argv=None) -> None:
    if not _windowless():
        _run(argv)
        return
    # Started from the desktop icon (pythonw.exe): keep a log and turn any crash into a visible message.
    import traceback

    from .config import LOG_DIR

    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        out = open(LOG_DIR / "bot.log", "a", encoding="utf-8", buffering=1)  # noqa: SIM115
        sys.stdout = sys.stderr = out
    except OSError:
        pass
    try:
        _run(argv)
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001
        text = traceback.format_exc()
        try:
            print(text)
        except Exception:  # noqa: BLE001
            pass
        _show_startup_error(text)


def _run(argv=None) -> None:
    _console_utf8()
    parser = argparse.ArgumentParser(prog="btc_bot", description="Crypto short-term movement predictor (signals only)")
    sub = parser.add_subparsers(dest="command")
    tf_help = "Timeframes to use (default: 5m 15m 1h)"
    for name, fn, help_text in [
        ("predict", cmd_predict, "Show one forecast and exit"),
        ("watch", cmd_watch, "Keep refreshing the forecast in this window"),
        ("backtest", cmd_backtest, "Measure past accuracy honestly (walk-forward)"),
        ("score", cmd_score, "Check how logged live predictions actually turned out"),
        ("swings", cmd_swings, "Find the daily swing windows from 5 years of data"),
        ("bigmoves", cmd_bigmoves, "Show the hours where a coin moved 2%%+ up or down"),
        ("webhook", cmd_webhook, "Receive TradingView webhook alerts"),
        ("gui", cmd_gui, "Open the desktop window"),
    ]:
        p = sub.add_parser(name, help=help_text)
        p.set_defaults(func=fn)
        if name in ("predict", "watch", "backtest"):
            p.add_argument("--timeframes", nargs="+", choices=TIMEFRAMES, default=list(TIMEFRAMES), help=tf_help)
        if name == "swings":
            p.add_argument("--years", type=int, default=5, help="Years of history to study (default 5)")
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
