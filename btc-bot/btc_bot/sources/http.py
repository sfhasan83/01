from __future__ import annotations

import time

import requests

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "btc-movement-bot/0.1"


def get_json(url: str, params: dict | None = None, headers: dict | None = None,
             retries: int = 3, timeout: int = 15):
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            resp = SESSION.get(url, params=params, headers=headers, timeout=timeout)
            if resp.status_code == 429:  # rate limited: back off
                time.sleep(2 ** attempt * 2)
                continue
            resp.raise_for_status()
            return resp.json()
        except (requests.RequestException, ValueError) as err:
            last_err = err
            time.sleep(1 + attempt)
    raise ConnectionError(f"Request to {url} failed: {last_err}")
