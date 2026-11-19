"""Simple desktop window (tkinter ships with Python on Windows, nothing extra to install)."""
from __future__ import annotations

import queue
import threading
import tkinter as tk
from tkinter import scrolledtext, ttk

from . import TIMEFRAMES
from .config import Settings
from .report import EXCHANGE_NAMES, TV_NAMES, hit_rate_text, local_hhmm, money, pct, result_line, signal_badge

COLOURS = {"UP": "#1a7f37", "DOWN": "#cf222e", "NEUTRAL": "#6e7781"}


class App:
    def __init__(self, root: tk.Tk, settings: Settings):
        self.root, self.settings = root, settings
        self.results: queue.Queue = queue.Queue()
        self.busy = False

        root.title("BTC Movement Bot (signals only)")
        root.geometry("1220x540")
        root.minsize(760, 360)

        top = ttk.Frame(root, padding=10)
        top.pack(fill="x")
        self.price_var = tk.StringVar(value="Loading prices...")
        self.cmc_var = tk.StringVar(value="")
        ttk.Label(top, textvariable=self.price_var, font=("Segoe UI", 12, "bold")).pack(anchor="w")
        ttk.Label(top, textvariable=self.cmc_var).pack(anchor="w")

        cols = ("tf", "call", "conf", "pup", "tv", "agree", "closes", "from", "last", "rate")
        heads = ("Timeframe", "Bot says", "Confidence", "P(up)", "TradingView", "Agree?",
                 "For candle closing", "From price", "Last result", "Hit rate")
        self.tree = ttk.Treeview(root, columns=cols, show="headings", height=len(TIMEFRAMES))
        for c, h in zip(cols, heads):
            self.tree.heading(c, text=h)
            self.tree.column(c, width={"last": 150, "rate": 240}.get(c, 95), anchor="center")
        for d, colour in COLOURS.items():
            self.tree.tag_configure(d, foreground=colour, font=("Segoe UI", 11, "bold"))
        self.tree.tag_configure("ERR", foreground="#9a6700")
        self.tree.pack(fill="x", padx=10)

        self.tv_note = ttk.Label(root, text="", foreground="#9a6700", padding=(10, 2, 10, 0))
        self.tv_note.pack(anchor="w")

        # One coloured line per timeframe: did the last UP/DOWN signal hit?
        box = ttk.LabelFrame(root, text="Signal results (checked when each candle closes)", padding=8)
        box.pack(fill="x", padx=10, pady=(8, 0))
        self.result_labels = {}
        for tf in TIMEFRAMES:
            row = ttk.Frame(box)
            row.pack(fill="x", anchor="w")
            ttk.Label(row, text=f"{tf:>4}", width=5, font=("Segoe UI", 10, "bold")).pack(side="left")
            badge = tk.Label(row, text="waiting", width=18, font=("Segoe UI", 10, "bold"),
                             fg="white", bg=COLOURS["NEUTRAL"])
            badge.pack(side="left", padx=(0, 8))
            detail = ttk.Label(row, text="")
            detail.pack(side="left")
            self.result_labels[tf] = (badge, detail)

        bar = ttk.Frame(root, padding=10)
        bar.pack(fill="x")
        ttk.Button(bar, text="Refresh now", command=self.refresh).pack(side="left")
        ttk.Button(bar, text="Run backtest", command=self.backtest).pack(side="left", padx=6)
        ttk.Button(bar, text="Live track record", command=self.score).pack(side="left")
        self.status = tk.StringVar(value="")
        ttk.Label(bar, textvariable=self.status).pack(side="right")

        ttk.Label(root, padding=(10, 0), wraplength=860, foreground="#6e7781", text=(
            "Signals only: this bot never places orders. Short-term BTC moves are close to random, "
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
        self.status.set("Backtesting (about a minute)...")
        from .backtest import format_result, walk_forward
        from .predictor import load_candles

        def job():
            parts = []
            for tf in TIMEFRAMES:
                try:
                    candles, src = load_candles(self.settings, tf, total=max(5000, self.settings.history_candles))
                    parts.append(format_result(walk_forward(candles, tf, self.settings.confidence_threshold,
                                                            self.settings.fee_rate)) + f"\n  (data: {src})")
                except Exception as err:  # noqa: BLE001
                    parts.append(f"== {tf}: failed: {err}")
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
        self.price_var.set("   ".join(f"{EXCHANGE_NAMES.get(k, k)}: {money(v)}" for k, v in snap.prices.items()))
        c = snap.cmc
        if c and (c.price is not None or c.fear_greed_value is not None):
            fg = f"{c.fear_greed_value} ({c.fear_greed_label})" if c.fear_greed_value is not None else "n/a"
            self.cmc_var.set(f"CoinMarketCap: 1h {pct(c.change_1h)}   24h {pct(c.change_24h)}   "
                             f"BTC dominance {pct(c.btc_dominance, False)}   Fear & Greed {fg}")
        elif c and c.error:
            self.cmc_var.set(f"CoinMarketCap: {c.error}")
        tv_errors = {p.tv.error for p in snap.predictions if p.tv.error}
        self.tv_note.configure(text=f"TradingView rating unavailable: {sorted(tv_errors)[0][:160]}" if tv_errors else "")
        self.tree.delete(*self.tree.get_children())
        for p in snap.predictions:
            if p.error or not p.signal:
                self.tree.insert("", "end", values=(p.timeframe, "error", "", "", "", "", "", p.error, "", ""),
                                 tags=("ERR",))
                continue
            s = p.signal
            self.tree.insert("", "end", tags=(s.direction,), values=(
                p.timeframe, s.direction, f"{s.confidence:.0%}", f"{s.p_up:.2f}",
                TV_NAMES.get(p.tv.recommendation or "", "n/a"),
                {True: "yes", False: "NO", None: "-"}[p.agrees_with_tv],
                local_hhmm(p.target_close_time), money(p.last_close),
                signal_badge(p.results), hit_rate_text(p.results)))
            if p.timeframe in self.result_labels:
                badge, detail = self.result_labels[p.timeframe]
                r = p.results
                colour = COLOURS["NEUTRAL"] if not r or r.last_hit is None else \
                    (COLOURS["UP"] if r.last_hit else COLOURS["DOWN"])
                badge.configure(text=signal_badge(r), bg=colour)
                detail.configure(text=result_line(r, p.target_close_time))
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
