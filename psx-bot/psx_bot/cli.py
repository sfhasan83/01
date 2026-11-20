"""Command line entry point:  python -m psx_bot <command>

No help text below may contain a bare percent sign: Python 3.14's argparse treats it as a
format code and crashes. Write "percent" (or a doubled sign) instead.
"""
from __future__ import annotations

import argparse
import sys

from .config import Settings

APP_NAME = "PSX Signal Bot"


def _console_utf8():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass


def cmd_update(settings: Settings, args) -> None:
    from .store import update_all

    print("Updating PSX prices. The first run downloads 5 years for every stock (a few minutes).\n")
    summary = update_all(settings, progress=print)
    print("\n" + summary.text())
    if summary.failed:
        sample = list(summary.failed.items())[:10]
        print("Failed (first 10): " + "; ".join(f"{s}: {e}" for s, e in sample))


def cmd_scan(settings: Settings, args) -> None:
    from .report import scan_text
    from .signals import run_scan

    if not args.no_update:
        cmd_update(settings, args)
        print()
    scan = run_scan(settings, progress=print, fast=args.fast)
    print()
    print(scan_text(scan, top=args.top, horizon=args.horizon, liquid_only=not args.all))


def cmd_show(settings: Settings, args) -> None:
    from .report import scan_text, stock_text
    from .signals import load_scan
    from .store import load_history

    scan = load_scan()
    if scan is None:
        print("No signals saved yet. Run: python -m psx_bot scan")
        return
    if args.symbol:
        sym = args.symbol.upper()
        if sym not in scan.table.index:
            print(f"{sym} is not in the last scan.")
            return
        print(stock_text(scan, sym, load_history(sym)))
    else:
        print(scan_text(scan, top=args.top, horizon=args.horizon, liquid_only=not args.all))


def cmd_backtest(settings: Settings, args) -> None:
    from .backtest import report_text, walk_forward

    print("Walk-forward backtest on all saved stocks. This takes a while (10 to 30 minutes, "
          "use --fast for a quicker rough run).\n")
    results = walk_forward(settings, progress=print, fast=args.fast)
    print()
    print(report_text(results, settings))


def cmd_score(settings: Settings, args) -> None:
    from .signals import live_record

    t = live_record(settings)
    if t.empty:
        print("No finished calls to check yet. Scan on a few trading days first.")
        return
    print("Live track record of past BUY/SELL calls:\n")
    print(t.to_string(index=False, float_format=lambda x: f"{x:.1%}"))


def cmd_gui(settings: Settings, args) -> None:
    from .gui import run

    run(settings)


def _windowless() -> bool:
    """True when started by pythonw.exe (the desktop icon): there is no console, so errors are invisible."""
    return sys.stdout is None or sys.stderr is None


def _show_startup_error(text: str) -> None:
    from .config import LOG_DIR

    log = LOG_DIR / "startup-error.log"
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        log.write_text(text, encoding="utf-8")
    except OSError:
        pass
    msg = (f"{APP_NAME} could not start.\n\n" + text[-1500:] + f"\n\nThis message was saved to:\n{log}\n\n"
           "Tip: run start-gui-debug.bat in the bot folder to see the full details, "
           "or run setup.bat again to repair the installation.")
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, msg, APP_NAME, 0x10)
        return
    except Exception:  # noqa: BLE001 - not Windows
        pass
    try:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(APP_NAME, msg)
        root.destroy()
    except Exception:  # noqa: BLE001
        pass


def main(argv=None) -> None:
    if not _windowless():
        _run(argv)
        return
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="psx_bot", description="PSX daily stock signals (signals only)")
    sub = parser.add_subparsers(dest="command")
    for name, fn, help_text in [
        ("update", cmd_update, "Download or refresh daily prices for every PSX stock"),
        ("scan", cmd_scan, "Update prices, then make today's BUY/SELL/HOLD signals"),
        ("show", cmd_show, "Show the last saved signals, or one stock with --symbol"),
        ("backtest", cmd_backtest, "Measure past accuracy honestly (walk-forward over the saved years)"),
        ("score", cmd_score, "Check how past logged calls actually turned out"),
        ("gui", cmd_gui, "Open the desktop window"),
    ]:
        p = sub.add_parser(name, help=help_text)
        p.set_defaults(func=fn)
        if name in ("scan", "show"):
            p.add_argument("--top", type=int, default=25, help="How many BUY and SELL calls to list (default 25)")
            p.add_argument("--horizon", choices=["1D", "1W", "1M"], default="1W",
                           help="Which horizon to rank by (default 1W)")
            p.add_argument("--all", action="store_true", help="Include illiquid stocks in the lists")
        if name == "scan":
            p.add_argument("--no-update", action="store_true", help="Use the saved prices, do not download")
        if name in ("scan", "backtest"):
            p.add_argument("--fast", action="store_true", help="Smaller, quicker models (rougher results)")
        if name == "show":
            p.add_argument("--symbol", help="One stock, e.g. --symbol OGDC")
    for p in sub.choices.values():
        p.add_argument("--stocks", nargs="+", metavar="SYMBOL",
                       help="Only these stocks instead of every listed stock, e.g. --stocks OGDC LUCK HUBC")
    return parser


def _run(argv=None) -> None:
    _console_utf8()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        args = parser.parse_args(["gui"])
    settings = Settings.load()
    if getattr(args, "stocks", None):
        settings.symbols = tuple(s.upper() for s in args.stocks)
    args.func(settings, args)
