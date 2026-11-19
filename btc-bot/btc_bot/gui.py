"""Simple desktop window (tkinter ships with Python on Windows, nothing extra to install)."""
from __future__ import annotations

import queue
import threading
import tkinter as tk
from tkinter import scrolledtext, ttk

from . import TIMEFRAMES
from .config import Settings, coin_name
from .report import TV_NAMES, cmc_line, hit_rate_text, local_hhmm, money, prediction_label, price_lines, signal_badge

COLOURS = {"UP": "#1a7f37", "DOWN": "#cf222e", "NEUTRAL": "#6e7781"}
SIDE_COLOURS = {"LONG": "#1a7f37", "SHORT": "#cf222e"}


class App:
    def __init__(self, root: tk.Tk, settings: Settings):
        self.root, self.settings = root, settings
        self.results: queue.Queue = queue.Queue()
        self.busy = False

        root.title("Crypto Movement Bot: " + ", ".join(coin_name(x) for x in settings.symbols) + " (signals only)")
        root.geometry("1400x700")
        root.minsize(760, 360)

        top = ttk.Frame(root, padding=10)
        top.pack(fill="x")
        self.price_var = tk.StringVar(value="Loading prices...")
        self.cmc_var = tk.StringVar(value="")
        ttk.Label(top, textvariable=self.price_var, font=("Segoe UI", 11, "bold"), justify="left").pack(anchor="w")
        ttk.Label(top, textvariable=self.cmc_var).pack(anchor="w")

        cols = ("coin", "tf", "side", "call", "conf", "pup", "tv", "agree", "closes", "from", "last", "rate")
        heads = ("Coin", "Timeframe", "Prediction", "Bot says", "Confidence", "P(up)", "TradingView", "Agree?",
                 "For candle closing", "From price", "Last result", "Hit rate")
        self.tree = ttk.Treeview(root, columns=cols, show="headings", height=len(TIMEFRAMES) * len(settings.symbols))
        for c, h in zip(cols, heads):
            self.tree.heading(c, text=h)
            self.tree.column(c, width={"coin": 60, "tf": 75, "side": 100, "last": 150, "rate": 240}.get(c, 92), anchor="center")
        # Rows are coloured by the prediction: green = LONG, red = SHORT
        for side, colour in SIDE_COLOURS.items():
            self.tree.tag_configure(side, foreground=colour, font=("Segoe UI", 11, "bold"))
        self.tree.tag_configure("ERR", foreground="#9a6700")
        self.tree.pack(fill="x", padx=10)

        self.tv_note = ttk.Label(root, text="", foreground="#9a6700", padding=(10, 2, 10, 0))
        self.tv_note.pack(anchor="w")

        # Coloured badges: one column per coin, one row per timeframe. Did the last prediction hit?
        box = ttk.LabelFrame(root, text="Signal results (checked when each candle closes)", padding=8)
        box.pack(fill="x", padx=10, pady=(8, 0))
        self.result_labels = {}
        for col, sym in enumerate(settings.symbols):
            ttk.Label(box, text=coin_name(sym), font=("Segoe UI", 11, "bold")).grid(
                row=0, column=col * 3, columnspan=3, sticky="w", padx=(0 if col == 0 else 24, 0))
            for r, tf in enumerate(TIMEFRAMES, start=1):
                pad = (0 if col == 0 else 24, 4)
                ttk.Label(box, text=tf, width=4).grid(row=r, column=col * 3, sticky="w", padx=pad)
                badge = tk.Label(box, text="waiting", width=18, font=("Segoe UI", 10, "bold"),
                                 fg="white", bg=COLOURS["NEUTRAL"])
                badge.grid(row=r, column=col * 3 + 1, sticky="w", pady=1)
                detail = ttk.Label(box, text="-", width=34)
                detail.grid(row=r, column=col * 3 + 2, sticky="w", padx=(6, 0))
                self.result_labels[(sym, tf)] = (badge, detail)

        bar = ttk.Frame(root, padding=10)
        bar.pack(fill="x")
        ttk.Button(bar, text="Refresh now", command=self.refresh).pack(side="left")
        ttk.Button(bar, text="Run backtest", command=self.backtest).pack(side="left", padx=6)
        ttk.Button(bar, text="Live track record", command=self.score).pack(side="left")
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
        self.status.set("Updating...")
        from .predictor import take_snapshot
        self._run("snapshot", lambda: take_snapshot(self.settings))

    def backtest(self):
        self.status.set("Backtesting (a few minutes for all coins)...")
        from .backtest import format_result, walk_forward
        from .predictor import load_candles

        def job():
            parts = []
            for sym in self.settings.symbols:
                for tf in TIMEFRAMES:
                    name = f"{coin_name(sym)} {tf}"
                    try:
                        candles, src = load_candles(self.settings, tf, total=max(5000, self.settings.history_candles),
                                                    symbol=sym)
                        parts.append(format_result(walk_forward(candles, name, self.settings.confidence_threshold,
                                                                self.settings.fee_rate)) + f"\n  (data: {src})")
                    except Exception as err:  # noqa: BLE001
                        parts.append(f"== {name}: failed: {err}")
            return "\n\n".join(parts)
        self._run("text:Backtest", job)

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
                        self.show(value)
                    self.root.after(self.settings.refresh_seconds * 1000, self.refresh)
                elif kind.startswith("text:"):
                    self.status.set("")
                    self.popup(kind[5:], str(err) if err else value)
        except queue.Empty:
            pass
        self.root.after(500, self.poll)

    # --- display ---------------------------------------------------------
    def show(self, snap):
        self.price_var.set("\n".join(price_lines(snap)))
        self.cmc_var.set(cmc_line(snap))
        tv_errors = {p.tv.error for p in snap.predictions if p.tv.error}
        self.tv_note.configure(text=f"TradingView rating unavailable: {sorted(tv_errors)[0][:160]}" if tv_errors else "")
        self.tree.delete(*self.tree.get_children())
        for p in snap.predictions:
            if p.error or not p.signal:
                self.tree.insert("", "end", values=(p.coin, p.timeframe, "-", "error", "", "", "", "", "", p.error, "", ""),
                                 tags=("ERR",))
                continue
            s = p.signal
            side = "LONG" if s.p_up > 0.5 else "SHORT"
            self.tree.insert("", "end", tags=(side,), values=(
                p.coin, p.timeframe, prediction_label(s), s.direction, f"{s.confidence:.0%}", f"{s.p_up:.2f}",
                TV_NAMES.get(p.tv.recommendation or "", "n/a"),
                {True: "yes", False: "NO", None: "-"}[p.agrees_with_tv],
                local_hhmm(p.target_close_time), money(p.last_close),
                signal_badge(p.results), hit_rate_text(p.results)))
            labels = self.result_labels.get((p.symbol, p.timeframe))
            if labels:
                badge, detail = labels
                r = p.results
                colour = COLOURS["NEUTRAL"] if not r or r.last_hit is None else \
                    (COLOURS["UP"] if r.last_hit else COLOURS["DOWN"])
                badge.configure(text=signal_badge(r), bg=colour)
                if r and r.last_hit is not None:
                    detail.configure(text=hit_rate_text(r))
                else:
                    detail.configure(text=f"first check {local_hhmm(p.target_close_time)}")
        self.status.set(f"Updated {snap.created.astimezone():%H:%M:%S}")

    def popup(self, title, text):
        win = tk.Toplevel(self.root)
        win.title(title)
        win.geometry("820x480")
        box = scrolledtext.ScrolledText(win, font=("Consolas", 10), wrap="none")
        box.insert("1.0", text)
        box.configure(state="disabled")
        box.pack(fill="both", expand=True)


def run(settings: Settings) -> None:
    root = tk.Tk()
    App(root, settings)
    root.mainloop()
