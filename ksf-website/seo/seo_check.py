#!/usr/bin/env python3
"""KSF Foods automatic SEO health check.

Crawls every page in the live sitemap (or a local folder) and writes a
Markdown report of problems that hurt Google ranking.

Usage:
  python3 seo_check.py                       # check https://ksffood.com
  python3 seo_check.py --local ../           # check the files in the repo
  python3 seo_check.py --out report.md       # also save the report
Exit code is 1 when any ERROR is found, so it can gate a deploy.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

SITE = "https://ksffood.com/"
UA = "KSF-SEO-Check/1.0"
BANNED_WORDS = ["organic"]  # KSF has no organic certificate: never claim it.
TITLE_RANGE = (25, 65)
DESC_RANGE = (70, 165)
MAX_IMAGE_KB = 300
MAX_PAGE_SECONDS = 2.5


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title, self.in_title = "", False
        self.meta, self.links, self.imgs, self.h1, self.ld = {}, [], [], 0, []
        self.canonical, self.lang, self.in_ld, self._ld = None, None, False, ""
        self.text = []

    def handle_starttag(self, tag, a):
        a = dict(a)
        if tag == "html":
            self.lang = a.get("lang")
        elif tag == "title":
            self.in_title = True
        elif tag == "meta":
            key = a.get("name") or a.get("property")
            if key:
                self.meta[key.lower()] = a.get("content", "")
        elif tag == "link" and a.get("rel") == "canonical":
            self.canonical = a.get("href")
        elif tag == "a" and a.get("href"):
            self.links.append(a["href"])
        elif tag == "img":
            self.imgs.append(a)
        elif tag == "source" and a.get("srcset"):
            for part in a["srcset"].split(","):
                self.imgs.append({"src": part.strip().split(" ")[0], "alt": "(picture source)"})
        elif tag == "h1":
            self.h1 += 1
        elif tag == "script" and a.get("type") == "application/ld+json":
            self.in_ld, self._ld = True, ""

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        elif tag == "script" and self.in_ld:
            self.in_ld = False
            self.ld.append(self._ld)

    def handle_data(self, d):
        if self.in_title:
            self.title += d
        if self.in_ld:
            self._ld += d
        else:
            self.text.append(d)


class Checker:
    def __init__(self, local=None):
        self.local = local
        self.issues = []  # (level, page, message)
        self.stats = []

    def add(self, level, page, msg):
        self.issues.append((level, page, msg))

    # ---------- fetching ----------
    def fetch(self, url, method="GET"):
        if self.local:
            path = urlparse(url).path.lstrip("/") or "index.html"
            fp = os.path.join(self.local, path)
            if not os.path.isfile(fp):
                return 404, b"", 0.0, {}
            return 200, open(fp, "rb").read(), 0.0, {}
        req = urllib.request.Request(url, method=method, headers={"User-Agent": UA})
        t = time.time()
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                body = r.read() if method == "GET" else b""
                return r.status, body, time.time() - t, dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, b"", time.time() - t, {}
        except Exception as e:  # network error
            return 0, str(e).encode(), time.time() - t, {}

    def status_no_redirect(self, url):
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):
                return None
        opener = urllib.request.build_opener(NoRedirect)
        try:
            r = opener.open(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=20)
            return r.status, r.headers.get("Location")
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("Location")
        except Exception:
            return 0, None

    # ---------- checks ----------
    def run(self):
        code, robots, _, _ = self.fetch(SITE + "robots.txt")
        if code != 200:
            self.add("ERROR", "robots.txt", f"robots.txt returned {code}")
        else:
            txt = robots.decode("utf-8", "ignore")
            if re.search(r"(?im)^disallow:\s*/\s*$", txt):
                self.add("ERROR", "robots.txt", "robots.txt blocks the whole site")
            if "sitemap:" not in txt.lower():
                self.add("WARN", "robots.txt", "robots.txt does not point to the sitemap")

        code, sm, _, _ = self.fetch(SITE + "sitemap.xml")
        pages = re.findall(r"<loc>([^<]+)</loc>", sm.decode("utf-8", "ignore")) if code == 200 else []
        if not pages:
            self.add("ERROR", "sitemap.xml", f"sitemap missing or empty (status {code})")
            pages = [SITE]

        if not self.local:
            for path, want in [("http://ksffood.com/", SITE), ("https://www.ksffood.com/", SITE),
                               (SITE + "index.html", SITE), (SITE + "about/", SITE + "about.html"), (SITE + "offers/", SITE + "products.html")]:
                c, loc = self.status_no_redirect(path)
                if c == 0:
                    continue  # network blocked this probe; skip
                if c not in (301, 308) or not loc or urljoin(path, loc) != want:
                    self.add("WARN", path, f"expected 301 to {want}, got {c} {loc or ''}")

        titles, descs, checked_assets, internal = {}, {}, set(), set()
        for url in pages:
            code, body, secs, headers = self.fetch(url)
            name = urlparse(url).path or "/"
            if code != 200:
                self.add("ERROR", name, f"page returned {code}")
                continue
            if secs > MAX_PAGE_SECONDS:
                self.add("WARN", name, f"slow response: {secs:.1f}s")
            html = body.decode("utf-8", "ignore")
            p = PageParser()
            p.feed(html)
            self.stats.append((name, len(body) // 1024, round(secs, 2), p.title.strip()))

            t = p.title.strip()
            if not t:
                self.add("ERROR", name, "missing <title>")
            elif not TITLE_RANGE[0] <= len(t) <= TITLE_RANGE[1]:
                self.add("WARN", name, f"title is {len(t)} chars (aim {TITLE_RANGE[0]}-{TITLE_RANGE[1]})")
            titles.setdefault(t, []).append(name)
            d = p.meta.get("description", "")
            if not d:
                self.add("ERROR", name, "missing meta description")
            elif not DESC_RANGE[0] <= len(d) <= DESC_RANGE[1]:
                self.add("WARN", name, f"meta description is {len(d)} chars (aim {DESC_RANGE[0]}-{DESC_RANGE[1]})")
            descs.setdefault(d, []).append(name)
            if "noindex" in p.meta.get("robots", ""):
                self.add("ERROR", name, "page is set to noindex")
            if p.canonical != url:
                self.add("WARN", name, f"canonical is {p.canonical!r}, expected {url}")
            if p.h1 != 1:
                self.add("WARN", name, f"page has {p.h1} <h1> tags (should be 1)")
            if not p.lang:
                self.add("WARN", name, "<html> has no lang attribute")
            if "viewport" not in p.meta:
                self.add("ERROR", name, "missing mobile viewport tag")
            for k in ("og:title", "og:description", "og:image"):
                if k not in p.meta:
                    self.add("WARN", name, f"missing {k} (social sharing preview)")
            if not p.ld:
                self.add("WARN", name, "no structured data (JSON-LD)")
            for block in p.ld:
                try:
                    json.loads(block)
                except ValueError as e:
                    self.add("ERROR", name, f"broken JSON-LD: {e}")
            visible = " ".join(p.text) + " " + t + " " + d + " " + " ".join(p.ld)
            for w in BANNED_WORDS:
                if re.search(rf"\b{w}\b", visible, re.I):
                    self.add("ERROR", name, f"uses the word '{w}', which KSF must not claim")
            for img in p.imgs:
                if "alt" not in img:
                    self.add("WARN", name, f"image without alt text: {img.get('src')}")
                src = img.get("src")
                if src and src not in checked_assets:
                    checked_assets.add(src)
                    self.check_asset(urljoin(url, src), name)
            for href in p.links:
                full = urljoin(url, href)
                if urlparse(full).netloc == "ksffood.com":
                    internal.add((full.split("#")[0], name))

        for t, where in titles.items():
            if t and len(where) > 1:
                self.add("WARN", ", ".join(where), f"duplicate title: {t}")
        for d, where in descs.items():
            if d and len(where) > 1:
                self.add("WARN", ", ".join(where), "duplicate meta description")
        seen = set()
        for link, page in sorted(internal):
            if link in seen:
                continue
            seen.add(link)
            code, _, _, _ = self.fetch(link)
            if code != 200:
                self.add("ERROR", page, f"broken internal link {link} ({code})")
        for link, _ in internal:
            if link not in pages and link.endswith(".html"):
                self.add("WARN", "sitemap.xml", f"linked page not in sitemap: {link}")
                pages.append(link)

    def check_asset(self, url, page):
        code, body, _, _ = self.fetch(url)
        if code != 200:
            self.add("ERROR", page, f"image not found: {url} ({code})")
        elif len(body) / 1024 > MAX_IMAGE_KB:
            self.add("WARN", page, f"heavy image {url} is {len(body)//1024} KB (aim < {MAX_IMAGE_KB} KB)")

    # ---------- report ----------
    def report(self):
        errors = [i for i in self.issues if i[0] == "ERROR"]
        warns = [i for i in self.issues if i[0] == "WARN"]
        out = [f"# KSF SEO health check, {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}", "",
               f"Source: {'local files ' + self.local if self.local else SITE}", "",
               f"**{len(errors)} errors, {len(warns)} warnings** across {len(self.stats)} pages.", "",
               "| Page | Size KB | Load s | Title |", "|---|---|---|---|"]
        out += [f"| {n} | {kb} | {s} | {t} |" for n, kb, s, t in self.stats]
        for label, group in (("Errors", errors), ("Warnings", warns)):
            out += ["", f"## {label}", ""]
            out += [f"- `{pg}`: {msg}" for _, pg, msg in group] or ["- None"]
        return "\n".join(out) + "\n", bool(errors)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", help="check a local folder instead of the live site")
    ap.add_argument("--out", help="save the Markdown report here")
    a = ap.parse_args()
    c = Checker(os.path.abspath(a.local) if a.local else None)
    c.run()
    text, failed = c.report()
    print(text)
    if a.out:
        with open(a.out, "w") as f:
            f.write(text)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
