# PSX Signal Bot

Daily BUY / SELL / HOLD signals for **every stock listed on the Pakistan Stock Exchange**, learned
from the last 5 years of daily prices. **Signals only: it never places orders.**

## What it does

1. **Downloads 5 years of daily prices** (open, high, low, close, volume) for every listed stock
   from the free PSX data portal, `dps.psx.com.pk`. No account or API key is needed. Bonds, sukuk
   and T-bills are left out, and ETFs are optional. The first download takes about 5 to 10 minutes,
   at roughly 2 requests a second so the PSX site is not hammered. After that, only stocks whose data
   is behind are downloaded again. If PSX fails for a stock, the bot tries Yahoo Finance (`OGDC.KA`).
2. **Trains one model per horizon on all stocks together**: tomorrow (1D), about a week (1W, 5
   sessions) and about a month (1M, 20 sessions). Five years of one stock is only about 1,200 days,
   which is too little to learn from. Pooled across ~500 stocks it is several hundred thousand
   examples. Features include returns, volatility, RSI, MACD, distance from the 20/50/100/200-day
   averages, Bollinger position, ATR, candle shape, volume surges, liquidity, the 52-week high and
   low, and how the stock does against the whole market and its breadth.
3. **Signals for the latest session**: the chance the stock closes higher after each horizon.
   At 55% or more (`CONFIDENCE_THRESHOLD`) that is a BUY, at 45% or less a SELL, and in between a
   HOLD with a slight lean ▲/▼. Each call comes with a take-profit and stop-loss based on the stock's
   daily range (ATR), 20-session support and resistance, trend, RSI and daily turnover.
4. **An honest walk-forward backtest** over the saved years. The model is retrained every quarter
   on data up to that point and only ever predicts days it has not seen. It reports accuracy against
   simple rules, how BUY calls did against the average stock after fees, a TP/SL simulation, a
   year-by-year breakdown, and a hit rate for each stock (shown in the "Backtest" column).
5. **Live track record**: every update logs that day's calls, and "Live track record" later checks
   how they turned out.

## Install (Windows)

1. Install Python 3.10 or newer from python.org, ticking **Add python.exe to PATH**.
2. Unzip `psx-bot.zip`, for example to `D:\PSX Bot\psx-bot`.
3. Double-click **setup.bat**. It installs the packages, creates `.env` and puts a
   **PSX Signal Bot** icon on your Desktop.
4. Double-click the icon. The window shows the last saved signals straight away, then updates the
   prices and signals in the background. The first run takes longest.

## The window

- **Header**: the date the prices go up to, the number of stocks, market breadth (the share of
  stocks above their 50-day average), the median 5-day move, and the number of 1-week calls.
- **Filters**: search by symbol or name, sector, BUY/SELL only, the horizon that colours the rows,
  and **Hide illiquid stocks** (on by default; illiquid means under Rs 2 million traded a day).
- Click a column heading to sort. Double-click a stock (or select it and click **Stock details**) for
  all three horizons, TP/SL, support and resistance, its backtest record and the last 10 sessions.
- **Run backtest** (10 to 30 minutes), **Last backtest**, **Live track record**, **Export to CSV**
  and **Open data folder** are along the bottom.

## Command line

```
.venv\Scripts\python.exe -m psx_bot update               download / refresh prices
.venv\Scripts\python.exe -m psx_bot scan                 update, then print today's top calls
.venv\Scripts\python.exe -m psx_bot scan --no-update     signals from the saved prices
.venv\Scripts\python.exe -m psx_bot show --symbol OGDC   one stock from the last scan
.venv\Scripts\python.exe -m psx_bot backtest [--fast]    walk-forward backtest
.venv\Scripts\python.exe -m psx_bot score                live track record
.venv\Scripts\python.exe -m psx_bot scan --stocks OGDC LUCK HUBC   only these stocks
```

`update-data.bat`, `scan.bat` and `backtest.bat` run the same commands with a double-click.

## Settings

Edit `.env` with Notepad. Every setting is explained in it: years of history, which stocks to
include, the illiquid limit, the confidence needed for a call, fees, and TP/SL distances.

## Files

- `data\history\<SYMBOL>.csv`: the saved daily prices (open them in Excel if you like).
- `data\symbols.csv`: every listed instrument with its name and sector.
- `logs\signals.csv`: the latest signals for every stock. `logs\backtest.txt`: the last backtest.
- `logs\signal_history.csv`: every day's calls, for the live track record.
- `logs\bot.log` and `logs\startup-error.log`: what to send if something goes wrong.

## If something goes wrong

- **Nothing downloads / "can't look up dps.psx.com.pk"**: the PC has no working internet or DNS
  (check the connection, VPN or firewall). The bot still shows the last saved signals.
- **"answered HTTP 403"**: the PSX site refused the requests. Since September 2026 its data pages need
  a short-lived code the site puts in its own home page; the bot reads it the same way a browser
  does. If PSX changes this again, the Yahoo fallback keeps most stocks working. Tell Claude.
- **The window does not open**: run `start-gui-debug.bat` and send the error it shows.

## Be careful

Daily stock moves are mostly noise. Even a model that is right 53 to 55% of the time is wrong almost
half the time, and illiquid stocks can be impossible to trade at the shown price. PSX limits how far
a price can move in a day, and short selling is only allowed for some stocks, so treat a SELL call as
"avoid or exit", not "short". Check the backtest, especially the year-by-year table, before you
trust any call. This is not investment advice.

Tests (no internet needed): `.venv\Scripts\python.exe -m pip install pytest` then
`.venv\Scripts\python.exe -m pytest tests`.
