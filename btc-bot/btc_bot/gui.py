"""Simple desktop window (tkinter ships with Python on Windows, nothing extra to install)."""
from __future__ import annotations

import queue
import threading
import tkinter as tk
from tkinter import scrolledtext, ttk

from . import TIMEFRAMES
from .config import PROJECT_DIR, Settings, coin_name
# Heavy modules (pandas, scikit-learn, the data sources) are imported in the background after the
# window is on screen, so the bot opens instantly instead of after several seconds.

COLOURS = {"UP": "#1a7f37", "DOWN": "#cf222e", "NEUTRAL": "#6e7781"}
SIDE_COLOURS = {"LONG": "#1a7f37", "SHORT": "#cf222e"}
TEXT = "#1f2328"
MUTED = "#6e7781"
GRID = "#d0d7de"
HEAD_BG = "#eaeef2"
ROW_BG = ("#ffffff", "#f6f8fa")
LEVEL_COLOURS = {"strong": "#0550ae", "medium": "#1f2328", "weak": "#6e7781"}  # blue = strong level


class App:
    def __init__(self, root: tk.Tk, settings: Settings):
        self.root, self.settings = root, settings
        self.results: queue.Queue = queue.Queue()
        self.busy = False
        self.last_snapshot = None

        root.title("Crypto Movement Bot: " + ", ".join(coin_name(x) for x in settings.symbols) + " (signals only)")
        root.geometry("1600x820")
        root.minsize(760, 360)
        icon = PROJECT_DIR / "bot.ico"
        if icon.exists():
            try:
                root.iconbitmap(default=str(icon))
            except tk.TclError:  # .ico files only work on Windows
                pass

        top = ttk.Frame(root, padding=10)
        top.pack(fill="x")
        self.price_var = tk.StringVar(value="Loading prices...")
        self.cmc_var = tk.StringVar(value="")
        ttk.Label(top, textvariable=self.price_var, font=("Segoe UI", 11, "bold"), justify="left").pack(anchor="w")
        ttk.Label(top, textvariable=self.cmc_var).pack(anchor="w")
        self.swing_label = tk.Label(top, text="", font=("Segoe UI", 10, "bold"), fg=TEXT, anchor="w", justify="left")
        self.swing_label.pack(anchor="w", pady=(4, 0))
        self.bigmove_label = tk.Label(top, text="", font=("Segoe UI", 10), fg=TEXT, anchor="w")
        self.bigmove_label.pack(anchor="w")

        # The table is a grid of labels (not a Treeview) so each cell can have its own colour,
        # and it always grows to fit every coin and timeframe.
        heads = ("Coin", "Timeframe", "Prediction", "Bot says", "Confidence", "TradingView", "Candle closes",
                 "Entry price", "Take profit", "Stop loss", "TP/SL result", "Last result",
                 "Support (bounce up)", "Resistance (bounce down)")
        widths = (5, 8, 10, 9, 9, 11, 11, 11, 11, 11, 11, 18, 20, 21)
        table = tk.Frame(root, bg=GRID, bd=1, relief="solid")
        table.pack(fill="x", padx=10)
        for c, (h, w) in enumerate(zip(heads, widths)):
            tk.Label(table, text=h, width=w, bg=HEAD_BG, fg=TEXT, font=("Segoe UI", 10, "bold"),
                     padx=4, pady=4).grid(row=0, column=c, sticky="nsew", padx=(0, 1), pady=(0, 1))
            table.grid_columnconfigure(c, weight=1)
        self.cells: dict[tuple[str, str], list[tk.Label]] = {}
        r = 1
        for i, sym in enumerate(settings.symbols):
            bg = ROW_BG[i % 2]  # shade alternate coins so the groups are easy to tell apart
            for tf in TIMEFRAMES:
                row = []
                for c, w in enumerate(widths):
                    lbl = tk.Label(table, text="", width=w, bg=bg, fg=TEXT, font=("Segoe UI", 10), padx=4, pady=3)
                    lbl.grid(row=r, column=c, sticky="nsew", padx=(0, 1), pady=(0, 1))
                    row.append(lbl)
                row[0].configure(text=coin_name(sym), font=("Segoe UI", 10, "bold"))
                row[1].configure(text=tf)
                row[2].configure(text="loading...", fg=MUTED)
                self.cells[(sym, tf)] = row
                r += 1

        self.tv_note = ttk.Label(root, text="", foreground="#9a6700", padding=(10, 2, 10, 0))
        self.tv_note.pack(anchor="w")

        # Coloured badges: one column per coin, one row per timeframe. Did the last prediction hit?
        box = ttk.LabelFrame(root, text="Signal results (checked when each candle closes)", padding=8)
        box.pack(fill="x", padx=10, pady=(8, 0))
        self.result_labels = {}
        for sym in settings.symbols:
            col = ttk.Frame(box)
            col.pack(side="left", fill="x", expand=True, anchor="n")
            ttk.Label(col, text=coin_name(sym), font=("Segoe UI", 11, "bold")).grid(row=0, column=0, columnspan=3, sticky="w")
            for r, tf in enumerate(TIMEFRAMES, start=1):
                ttk.Label(col, text=tf, width=4).grid(row=r, column=0, sticky="w")
                badge = tk.Label(col, text="waiting", width=17, font=("Segoe UI", 10, "bold"),
                                 fg="white", bg=COLOURS["NEUTRAL"])
                badge.grid(row=r, column=1, sticky="w", pady=1)
                detail = ttk.Label(col, text="-")
                detail.grid(row=r, column=2, sticky="w", padx=(6, 12))
                self.result_labels[(sym, tf)] = (badge, detail)

        bar = ttk.Frame(root, padding=10)
        bar.pack(fill="x")
        ttk.Button(bar, text="Refresh now", command=self.refresh).pack(side="left")
        ttk.Button(bar, text="Run backtest", command=self.backtest).pack(side="left", padx=6)
        ttk.Button(bar, text="Live track record", command=self.score).pack(side="left")
        ttk.Button(bar, text="Swing times", command=self.swings).pack(side="left", padx=6)
        ttk.Button(bar, text="Rebound levels", command=self.show_levels).pack(side="left")
        ttk.Button(bar, text="Big moves (2%+)", command=self.show_bigmoves).pack(side="left", padx=6)
        self.status = tk.StringVar(value="")
        ttk.Label(bar, textvariable=self.status).pack(side="right")

        ttk.Label(root, padding=(10, 0), wraplength=860, foreground="#6e7781", text=(
            "Signals only: this bot never places orders. Short-term crypto moves are close to random, "
            "so even a good model is wrong very often. Check the backtest before trusting any call.")).pack(anchor="w")

        self.root.after(200, self.refresh)
        self.root.after(500, self.poll)

    # --- background work -------------------------------------------------
    def _run(self, kind, fn):
        def worker():
            try:
                self.results.put((kind, fn(), None))
            except Exception as err:  # noqa: BLE001
                self.results.put((kind, None, err))
        threading.Thread(target=worker, daemon=True).start()

    def refresh(self):
        if self.busy:
            return
        self.busy = True
        self.status.set("Updating..." if self.last_snapshot else
                        "Starting: downloading prices and training (first start takes longest)...")

        def job():
            from .predictor import take_snapshot  # imported here, off the window's thread

            return take_snapshot(self.settings)
        self._run("snapshot", job)

    def backtest(self):
        self.status.set("Backtesting (a few minutes for all coins)...")

        def job():
            from .backtest import format_result, walk_forward
            from .predictor import load_candles

            parts = []
            for sym in self.settings.symbols:
                for tf in TIMEFRAMES:
                    name = f"{coin_name(sym)} {tf}"
                    try:
                        candles, src = load_candles(self.settings, tf, total=max(5000, self.settings.history_candles),
                                                    symbol=sym)
                        parts.append(format_result(walk_forward(candles, name, self.settings.confidence_threshold,
                                                                self.settings.fee_rate,
                                                                sl_mult=self.settings.sl_atr_mult,
                                                                tp_mult=self.settings.tp_atr_mult,
                                                                tp_sl_candles=self.settings.tp_sl_candles)) + f"\n  (data: {src})")
                    except Exception as err:  # noqa: BLE001
                        parts.append(f"== {name}: failed: {err}")
            return "\n\n".join(parts)
        self._run("text:Backtest", job)

    def show_bigmoves(self):
        from .bigmoves import report_text

        self.popup("Big moves", report_text(self.settings.big_move_pct))

    def show_levels(self):
        if self.last_snapshot is None:
            self.status.set("Wait for the first update, then try again.")
            return
        from .report import levels_report

        self.popup("Rebound levels", levels_report(self.last_snapshot))

    def tick_swings(self):
        """Update the 'next swing window' line every 30 seconds; orange when a window is near."""
        from .swings import load_results, next_window_text, next_windows

        data = load_results()
        self.swing_label.configure(text=next_window_text(data))
        upcoming = next_windows(data)
        near = False
        if upcoming:
            from datetime import datetime
            mins = (upcoming[0][0] - datetime.now().astimezone()).total_seconds() / 60
            near = mins <= 30
        self.swing_label.configure(fg="#bc4c00" if near else TEXT)
        self.root.after(30_000, self.tick_swings)

    def tick_swings_once(self):
        from .swings import load_results, next_window_text

        self.swing_label.configure(text=next_window_text(load_results()))

    def swings(self):
        self.status.set("Studying swing times (first run downloads 5 years of data, a few minutes)...")
        from .swings import load_results, report_text, run_study

        def job():
            results = run_study(self.settings, progress=lambda msg: self.results.put(("status", msg, None)))
            return report_text(results)
        data = load_results()
        if data:  # show the saved study straight away, refresh it in the background
            self.popup("Swing times (saved study, updating...)", report_text(data["coins"]))
        self._run("text:Swing times", job)

    def score(self):
        from .predictor import score_log

        def job():
            t = score_log(self.settings)
            return "No finished predictions logged yet." if t.empty else \
                t.to_string(index=False, float_format=lambda x: f"{x:.1%}")
        self._run("text:Live track record", job)

    def poll(self):
        try:
            while True:
                kind, value, err = self.results.get_nowait()
                if kind == "snapshot":
                    self.busy = False
                    if err:
                        self.status.set(f"Update failed: {err}")
                    else:
                        first = self.last_snapshot is None
                        self.show(value)
                        if first:
                            self.tick_swings()
                    self.root.after(self.settings.refresh_seconds * 1000, self.refresh)
                elif kind == "status":
                    self.status.set(value)
                elif kind.startswith("text:"):
                    self.status.set("")
                    self.popup(kind[5:], str(err) if err else value)
                    if kind == "text:Swing times":
                        self.root.after(100, self.tick_swings_once)
        except queue.Empty:
            pass
        self.root.after(500, self.poll)

    # --- display ---------------------------------------------------------
    def show(self, snap):
        from .levels import level_text
        from .report import (TV_NAMES, cmc_line, hit_rate_text, local_hhmm, money, prediction_label, price_lines,
                             signal_badge, tpsl_badge, tpsl_text)

        self.last_snapshot = snap
        from .bigmoves import latest_text

        self.bigmove_label.configure(text=latest_text())
        self.price_var.set("\n".join(price_lines(snap)))
        self.cmc_var.set(cmc_line(snap))
        tv_errors = {p.tv.error for p in snap.predictions if p.tv.error}
        self.tv_note.configure(text=f"TradingView rating unavailable: {sorted(tv_errors)[0][:160]}" if tv_errors else "")
        bold = ("Segoe UI", 10, "bold")
        normal = ("Segoe UI", 10)
        for p in snap.predictions:
            row = self.cells.get((p.symbol, p.timeframe))
            if not row:
                continue
            if p.error or not p.signal:
                values = ["-", "error", "", "", "", "", "", "", "", "", (p.error or "")[:40], ""]
                for lbl, v in zip(row[2:], values):
                    lbl.configure(text=v, fg="#9a6700", font=normal)
                continue
            s = p.signal
            r = p.results
            side = "LONG" if s.p_up > 0.5 else "SHORT"
            tv = TV_NAMES.get(p.tv.recommendation or "", "n/a")
            tv_colour = {"UP": COLOURS["UP"], "DOWN": COLOURS["DOWN"]}.get(p.tv.direction, MUTED)
            result_colour = MUTED if not r or r.last_hit is None else (COLOURS["UP"] if r.last_hit else COLOURS["DOWN"])
            t = p.tpsl_results
            tpsl_colour = MUTED if not t or t.last_outcome in (None, "EXPIRED") else \
                (COLOURS["UP"] if t.last_outcome == "TP" else COLOURS["DOWN"])
            sup = p.supports[0] if p.supports else None
            res = p.resistances[0] if p.resistances else None
            cells = [
                (prediction_label(s), SIDE_COLOURS[side], bold),
                (s.direction, COLOURS[s.direction], bold if s.direction != "NEUTRAL" else normal),
                (f"{s.confidence:.0%}", TEXT, normal),
                (tv, tv_colour if tv != "n/a" else MUTED, normal),
                (local_hhmm(p.target_close_time), TEXT, normal),
                (money(p.last_close), TEXT, normal),
                (money(p.take_profit), COLOURS["UP"], normal),
                (money(p.stop_loss), COLOURS["DOWN"], normal),
                (tpsl_badge(p.tpsl_results), tpsl_colour, bold if tpsl_colour != MUTED else normal),
                (signal_badge(r), result_colour, bold if r and r.last_hit is not None else normal),
                (level_text(sup), LEVEL_COLOURS.get(sup.strength if sup else "", MUTED), normal),
                (level_text(res), LEVEL_COLOURS.get(res.strength if res else "", MUTED), normal),
            ]
            for lbl, (text, fg, font) in zip(row[2:], cells):
                lbl.configure(text=text, fg=fg, font=font)
            labels = self.result_labels.get((p.symbol, p.timeframe))
            if labels:
                badge, detail = labels
                r = p.results
                colour = COLOURS["NEUTRAL"] if not r or r.last_hit is None else \
                    (COLOURS["UP"] if r.last_hit else COLOURS["DOWN"])
                badge.configure(text=signal_badge(r), bg=colour)
                if r and r.last_hit is not None:
                    detail.configure(text=hit_rate_text(r) + f"\nTP/SL: {tpsl_text(p.tpsl_results)}")
                else:
                    detail.configure(text=f"first check {local_hhmm(p.target_close_time)}")
        self.status.set(f"Updated {snap.created.astimezone():%H:%M:%S}")

    def popup(self, title, text):
        win = tk.Toplevel(self.root)
        win.title(title)
        win.geometry("1150x560")
        box = scrolledtext.ScrolledText(win, font=("Consolas", 10), wrap="none")
        box.insert("1.0", text)
        box.configure(state="disabled")
        box.pack(fill="both", expand=True)


def run(settings: Settings) -> None:
    root = tk.Tk()
    App(root, settings)
    root.mainloop()
