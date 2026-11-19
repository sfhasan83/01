# Crypto Movement Bot (Windows): BTC, ETH, SOL

A small Windows program that predicts whether **Bitcoin (BTC), Ethereum (ETH) and Solana (SOL)** will go **UP** or **DOWN** over the next
**5 minutes, 15 minutes and 1 hour**, using data from **Binance, MEXC, CoinMarketCap and TradingView**.

> **Signals only.** The bot never logs in to an exchange and never places orders.
> **Please read [How good are the predictions?](#how-good-are-the-predictions) before using it.**

## What you get

- A **desktop window** (`start-gui.bat`) that refreshes every minute.
- A **console view** (`start-watch.bat`) if you prefer a text screen.
- A **backtest** (`backtest.bat`) that shows how accurate the bot would have been on recent history.
- A **live track record**: every prediction is saved to `logs\predictions.csv`, and the
  "Live track record" button (or `python -m btc_bot score`) checks how they actually turned out.
- An optional **TradingView alert receiver** (`start-webhook.bat`).

For each coin and timeframe it shows:

| Column | Meaning |
|---|---|
| Coin | BTC, ETH or SOL |
| Prediction | **LONG ▲** (green) if the model leans up, **SHORT ▼** (red) if it leans down. Always shown, even when the bot says NEUTRAL |
| Bot says | `UP` or `DOWN` when the model is confident enough, otherwise `NEUTRAL` (treat LONG/SHORT on a NEUTRAL row as a weak lean) |
| Confidence | How sure the model is (50% = coin flip) |
| P(up) | The model's probability that the candle closes higher |
| TradingView | TradingView's own technical rating for the same timeframe (Strong buy ... Strong sell) |
| Agree? | Whether the bot and TradingView point the same way |
| Candle closes | The local time the predicted candle closes |
| Entry price | The last closed price the prediction (and TP/SL) is measured from |
| Take profit / Stop loss | Suggested exit prices for the LONG or SHORT, see below |
| TP/SL result | Whether the latest finished suggestion reached **TP ✔** (green) or **SL ✘** (red) first, or **expired** |
| Support (bounce up) / Resistance (bounce down) | The nearest rebound levels below and above the price, with how many times price rebounded out of the times it tested them (e.g. `$62,810.00 · 5/7`). Blue = strong level, grey = weak or new |
| Last result | **YES ✔ HIT** if the bot's last prediction was right once its candle closed, **NO ✘ MISSED** if not. A NEUTRAL row is still checked by which way it leaned (P(up) above 0.5 = UP) and is marked **(lean)** |
| Hit rate | `signals` counts only the confident UP/DOWN calls; `all` counts every prediction by its lean, e.g. `signals 3/5 (60%) · all 11/20 (55%)` |

Under the table, a **Signal results** box shows the same thing in green (hit) or red (missed), one column per coin
and one row per timeframe. The console view (`start-watch.bat`) also prints the price move that decided each result. Before the first candle closes it says when the first check happens
(about 5 minutes for 5m, up to an hour for 1h).
Results are kept in `logs\predictions.csv`, so the hit rate carries over when you close and reopen the bot.

Above the table you see each coin's live price on Binance and MEXC, and from CoinMarketCap each coin's 1h and 24h change,
BTC dominance and the Fear & Greed index.

## Setup on Windows (about 5 minutes)

1. **Install Python 3.10 or newer** from <https://www.python.org/downloads/>.
   On the first installer screen tick **"Add python.exe to PATH"**.
2. **Download this folder**: on GitHub click **Code → Download ZIP**, unzip it, and open the `btc-bot` folder.
3. **Double-click `setup.bat`.** It creates a private Python environment in `.venv`, installs everything,
   and puts a **Crypto Movement Bot** icon on your Desktop. (If Windows shows "Windows protected your PC",
   click **More info → Run anyway**.)
4. **Get a free CoinMarketCap API key** at <https://coinmarketcap.com/api/> (Basic plan).
   Open the new `.env` file in Notepad and paste it after `CMC_API_KEY=`. Save.
   (The bot still works without it; you just won't see the CoinMarketCap line.)
5. **Double-click the "Crypto Movement Bot" icon** that setup put on your Desktop (also in the Start menu).
   If the icon is missing, double-click `create-shortcut.bat` to make it again, or use `start-gui.bat`. The window opens straight away. The very first update downloads price history and trains 9 models (3 coins × 3 timeframes), usually within 10 to 30 seconds. After that the bot saves the prices in `logs\cache`, so later starts and refreshes only download the newest candles, and it reuses each model until a new candle closes.

Binance, MEXC and TradingView need **no account or key**: the bot only reads public market data.

## Commands

Double-click a `.bat` file, or run these in a Command Prompt inside the folder:

| What | Double-click | Or type |
|---|---|---|
| Desktop window | Desktop icon, or `start-gui.bat` | `.venv\Scripts\python -m btc_bot gui` |
| Console, auto-refresh | `start-watch.bat` | `.venv\Scripts\python -m btc_bot watch` |
| One forecast | | `.venv\Scripts\python -m btc_bot predict` |
| Backtest | `backtest.bat` | `.venv\Scripts\python -m btc_bot backtest --candles 5000` (add `--coins SOLUSDT` for one coin) |
| Live track record | | `.venv\Scripts\python -m btc_bot score` |
| Big moves (2%+) | `big-moves.bat` | `.venv\Scripts\python -m btc_bot bigmoves` |
| Daily swing windows | `swing-times.bat` | `.venv\Scripts\python -m btc_bot swings --years 5` |
| TradingView alerts | `start-webhook.bat` | `.venv\Scripts\python -m btc_bot webhook` |

## Settings (`.env`)

| Setting | Default | What it does |
|---|---|---|
| `CMC_API_KEY` | empty | CoinMarketCap key |
| `SYMBOLS` | `BTCUSDT,ETHUSDT,SOLUSDT` | Coins to follow, comma separated. Add or remove pairs here (e.g. `BTCUSDT,SOLUSDT`) |
| `PRIMARY_EXCHANGE` | `binance` | Exchange the model learns from. If it fails, the bot switches to the other one automatically |
| `HISTORY_CANDLES` | `3000` | Past candles used to train each timeframe |
| `CONFIDENCE_THRESHOLD` | `0.58` | Below this the bot says NEUTRAL instead of guessing |
| `REFRESH_SECONDS` | `60` | How often the window refreshes |
| `WEBHOOK_PORT` / `WEBHOOK_SECRET` | `8080` / `change-me` | TradingView alert receiver |
| `FEE_RATE` | `0.001` | Fee per trade side used by the backtest (0.1%) |
| `SL_ATR_MULT` / `TP_ATR_MULT` | `1.0` / `1.5` | Stop-loss and take-profit distance in ATRs |
| `TP_SL_CANDLES` | `3` | Candles to wait for TP or SL before a call expires |
| `BIG_MOVE_PCT` | `2.0` | Record hours that went this many % up or down |

## Take Profit and Stop Loss

For every row the bot suggests a take-profit and a stop-loss price, based on **ATR** (the average size of one
candle on that timeframe, over the last 14 candles):

| | Stop loss | Take profit |
|---|---|---|
| LONG | entry − 1.0 × ATR | entry + 1.5 × ATR |
| SHORT | entry + 1.0 × ATR | entry − 1.5 × ATR |

So by default you risk 1 to aim for 1.5. After each call the bot watches the next 3 candles and records
which level price touched first. If both are touched inside one candle it counts as a stop loss, because
there's no way to know which came first. If neither is touched, the call **expires** at the 3rd candle's close.
The Signal results box shows the running count, e.g. `TP 4 · SL 3 · exp 1 (50% TP) · +0.6R`. **R** is profit
in units of risk: +1.5R for a take profit, −1R for a stop loss. A positive total means the TP/SL plan would
have made money before fees.

Change the distances in `.env`: `SL_ATR_MULT`, `TP_ATR_MULT` and `TP_SL_CANDLES`. The backtest also tests
the TP/SL plan on the confident calls, after fees. These are suggestions only, and the bot never places orders.

## Rebound levels (support and resistance)

For every coin and timeframe the bot finds the price levels where price has turned before:

- **Swing points**: candles whose high or low is the highest or lowest of the 5 candles on each side.
  Swing prices within half an ATR of each other are merged into one level.
- **Support** is a level below the current price, where price tends to **bounce up**. **Resistance** is a level above it,
  where price tends to **bounce down**.
- **Rebound rate**: every later time price came back to a level counts as a test. It's a **rebound** if price then
  closed 1 ATR back the way it came before closing 1 ATR through the level, and a **break** otherwise. The two
  distances are equal, so on random prices the rate is about 50%. Only levels clearly above 50%, with several tests,
  mean much. "Strong" needs at least 6 finished tests and a clearly above-50% rate.

The table shows the nearest support and resistance. **Rebound levels** opens the 3 nearest on each side for every
coin and timeframe, with their swing count and full rebound record.

## Big moves: hours with a 2%+ move up or down

The bot records every **1-hour candle** in which a coin went **2% or more UP** (high vs the hour's open) **or
2% or more DOWN** (low vs the hour's open) in `logs\big_moves.csv`, which opens in Excel. Each row has the date
and hour in your time zone, the coin, the direction (UP, DOWN, or BOTH if it did both), the size of each move,
and the open-to-close change.

- It starts with about 4 months of past hours on the first refresh and adds new ones as they close.
  Running **Swing times** fills in the full 5 years.
- The line at the top shows the latest one, e.g. `Last 2%+ hour: SOL 2026-11-19 18:00  UP +2.41%`.
- **Big moves (2%+)** (or `big-moves.bat`) shows, for each coin: how many big hours, how many per day, UP vs DOWN,
  the busiest hours of the day as a bar chart, and the latest 30.
- Change the threshold with `BIG_MOVE_PCT` in `.env`.

## Daily swing windows (5-year study)

Click **Swing times** in the window (or double-click `swing-times.bat`). The bot downloads **5 years of
hourly prices** for each coin from Binance and finds the times of day when swing tops and bottoms happen most.
The first run takes a few minutes. The data is saved in `logs\history`, so later runs only fetch the new hours.

- A **swing** is an hour whose high is the highest (a top) or whose low is the lowest (a bottom) of the 6 hours
  on each side, *and* after which price moves at least 2 ATR away. That leaves real turning points, not noise.
- The bot counts swings by hour of day in **your computer's time zone** and picks the **3 busiest hours**,
  at least 3 hours apart. For each window the report shows how often it has a swing, how much busier it is than an
  average hour, whether it's mostly tops or bottoms, and the typical move afterwards.
- The window shows **"Next swing window: 17:00-18:00 (in 20 min) for BTC/SOL"** at the top. It turns orange
  when a window is 30 minutes away or running.
- **Honesty check:** the report also picks the windows *without* the last 12 months, then measures how many
  of the last 12 months' swings actually fell inside them, compared with pure chance (3 hours out of 24 = 12.5%).
  It also lists the top hours for each year separately, so you can see whether the pattern stays the same.
  If it doesn't beat chance, the report says so.

A window means swings happen there **more often** than at other hours. It does not promise a swing today.

## How it works

1. **Data.** For each coin, downloads the latest closed 5m, 15m and 1h candles from Binance (or MEXC as a fallback).
   The candle that is still forming is ignored, so the model only sees finished candles.
2. **Features.** Builds about 30 standard indicators from those candles: recent returns, volatility,
   RSI, MACD, distance from the 20 and 50 EMAs, Bollinger %B, ATR, candle shape, volume surprise and time of day.
3. **Model.** For each coin and timeframe (9 in all) it trains a blend of logistic regression and small gradient-boosted
   trees (scikit-learn) on the latest candles, then predicts whether the *next* candle closes higher.
   It retrains on every refresh, so it keeps up with the market.
4. **TradingView.** TradingView has no official public data API. The bot uses the
   [`tradingview-ta`](https://pypi.org/project/tradingview-ta/) library to read TradingView's own
   technical rating for each coin (BINANCE:BTCUSDT, ETHUSDT, SOLUSDT) on each timeframe and shows it next to the bot's call.
   It is shown for comparison and is not mixed into the bot's probability, because it can't be backtested.
5. **CoinMarketCap.** Shows market-wide context (24h change, dominance, Fear & Greed). It is not used by
   the model either, since the free plan has no minute-by-minute history to learn from.

### TradingView alerts (optional)

If you have your own TradingView strategy or indicator alerts, the bot can show them too:

1. Run `start-webhook.bat` (keeps running on port 8080).
2. TradingView must be able to reach your PC from the internet. Use a tunnel such as
   [ngrok](https://ngrok.com/) (`ngrok http 8080`) or Cloudflare Tunnel, or forward port 8080 on your router.
   Webhooks need a paid TradingView plan.
3. In the TradingView alert, set **Webhook URL** to `https://<your-tunnel-address>/tradingview` and the **Message** to:
   ```json
   {"secret": "your WEBHOOK_SECRET", "symbol": "{{ticker}}", "timeframe": "{{interval}}", "action": "buy", "price": {{close}}}
   ```
   Use `"action": "sell"` for sell alerts. The latest alert per timeframe appears under the forecast.

## How good are the predictions?

Honestly: **not very, and nobody's are.** Over 5 to 60 minutes, the direction of BTC, ETH or SOL is very close to a coin flip.
Most of the movement is noise, any pattern that works gets traded away quickly, and fees eat small edges.
Expect accuracy in the **50% to 55%** range, and some weeks below 50%.

That is why the bot includes two honest checks:

- **Backtest (walk-forward).** It trains only on the past, predicts the next block of candles it has never seen,
  moves forward and repeats. It reports accuracy against two simple rules ("always up" and "same as last candle")
  and what following the confident calls would have earned **after fees**. If the bot doesn't beat the simple rules,
  the report says so.
- **Live track record.** Real predictions logged while you use it, scored against what really happened.
  This is the number to trust, once a few hundred predictions have been checked.

In testing on purely random price data the bot correctly reports **no edge** (about 50% accuracy) and
shows that trading its calls would lose money to fees. Run the backtest on real data and judge for yourself.

**Do not trade money you can't afford to lose based on this bot.** It is a tool for study, not financial advice.

## Troubleshooting

- **"Python was not found"**: reinstall Python and tick "Add python.exe to PATH", then run `setup.bat` again.
- **"Could not load candles"**: your internet or country may block Binance. Set `PRIMARY_EXCHANGE=mexc` in `.env`.
- **TradingView shows n/a**: the reason is printed in orange under the table. The bot asks TradingView for all coins
  in one request per timeframe and reuses the answer for 3 to 10 minutes. If TradingView still answers "HTTP 429"
  (too many requests), the bot keeps the last rating and waits 10 minutes before asking again.
- **CoinMarketCap errors**: check the key in `.env`. The free plan allows about 330 calls a day, so the bot
  refreshes CoinMarketCap only every 15 minutes (about 290 calls a day if left running), even when the prices refresh every minute.

## For developers

```
btc_bot/
  sources/   binance.py, mexc.py, coinmarketcap.py, tradingview.py (data)
  features.py   indicators (no look-ahead)
  model.py      logistic regression + gradient boosting blend
  backtest.py   walk-forward backtest
  predictor.py  ties sources and model together, logs predictions
  gui.py / cli.py / webhook.py
tests/          offline tests with synthetic data and mocked APIs
```

Run the tests with `pip install pytest` and `python -m pytest tests`.
