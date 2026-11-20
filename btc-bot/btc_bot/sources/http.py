from __future__ import annotations

import time
from urllib.parse import urlparse

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
            if 400 <= resp.status_code < 500:
                # e.g. "invalid symbol": asking again won't help, so fail straight away
                raise ConnectionError(f"Request to {url} failed: HTTP {resp.status_code} {resp.text[:200]}")
            resp.raise_for_status()
            return resp.json()
        except (requests.RequestException, ValueError) as err:
            last_err = err
            time.sleep(1 + attempt)
    raise ConnectionError(_explain(url, last_err))


def _explain(url: str, err: Exception | None) -> str:
    """Short, plain message instead of a page of urllib3 text."""
    host = urlparse(url).hostname or url
    text = str(err)
    if "NameResolutionError" in text or "getaddrinfo failed" in text or "Name or service not known" in text:
        return (f"can't look up {host}: this PC has no working internet/DNS right now "
                "(check the connection, VPN or firewall)")
    if "ConnectTimeout" in text or "timed out" in text:
        return f"{host} did not answer in time (slow or blocked connection)"
    if "SSLError" in text or "CERTIFICATE" in text:
        return f"secure connection to {host} failed (antivirus web shield or proxy?): {text[:120]}"
    return f"Request to {url} failed: {text[:200]}"
