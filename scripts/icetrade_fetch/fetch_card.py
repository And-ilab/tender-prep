#!/usr/bin/env python3
"""
Сбор URL файлов с карточки IceTrade (анал Node bootstrap): Playwright + разбор ответов XHR + BeautifulSoup + regex.

Установка (в каталоге scripts/icetrade_fetch или из корня репо):
  pip install -r requirements.txt
  playwright install chromium

Вывод: одна JSON-строка в stdout (--json), логи — в stderr.

Пример:
  python fetch_card.py 1336336 --json
  python fetch_card.py 1336336 --json --storage C:\\secrets\\icetrade-storage.json
  python fetch_card.py 1336336 --json --http-only
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from urllib.parse import urljoin

PAGE_TMPL = "https://icetrade.by/tenders/all/view/{view_id}"

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

FILE_EXT_RE = re.compile(
    r"\.(pdf|docx?|zip|rar|7z|xlsx?|csv|txt|pptx?)(\?|#|$)",
    re.I,
)

ABS_FILE_RE = re.compile(
    r"https?:\/\/(?:www\.)?icetrade\.by[-a-z0-9+&@#/%?=~_|!:,.;]*\.(?:pdf|docx?|zip|rar|7z|xlsx?|csv|txt)(?:\?[-a-z0-9+&@#/%?=~_|!:,.;]*)?",
    re.I,
)

ABS_GOSZ_GETFILE_RE = re.compile(
    r"https?:\/\/(?:www\.)?goszakupki\.by\/auction\/get-file\/\d+[-a-z0-9+&@#/%?=~_|!:,.;]*",
    re.I,
)

REL_FILE_RE = re.compile(
    r'["\'](/[-a-z0-9+&@#/%?=~_|!:,.;]*\.(?:pdf|docx?|zip|rar|7z|xlsx?|csv|txt)(?:\?[^"\'\\]*)?)["\']',
    re.I,
)


def _file_urls_from_text(text: str, max_len: int = 5_000_000) -> list[str]:
    if not text or len(text) > max_len:
        return []
    found: set[str] = set()
    for m in ABS_FILE_RE.finditer(text):
        found.add(m.group(0))
    for m in ABS_GOSZ_GETFILE_RE.finditer(text):
        found.add(m.group(0))
    for m in REL_FILE_RE.finditer(text):
        try:
            found.add(urljoin("https://icetrade.by", m.group(1)))
        except Exception:
            pass
    return sorted(found)


def _filter_file_hrefs(urls: list[tuple[str, str | None]]) -> list[str]:
    out: set[str] = set()
    for href, text in urls:
        if FILE_EXT_RE.search(href):
            out.add(href)
            continue
        if ABS_GOSZ_GETFILE_RE.match(href):
            out.add(href)
            continue
        t = (text or "").strip()
        if t and FILE_EXT_RE.search(t) and ABS_GOSZ_GETFILE_RE.match(href):
            out.add(href)
    return sorted(out)
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    pairs: list[tuple[str, str | None]] = []
    for a in soup.find_all("a", href=True):
        href = str(a.get("href", "")).strip()
        if not href or href.startswith("#") or href.lower().startswith("javascript:"):
            continue
        text = a.get_text(strip=True) or None
        try:
            abs_u = urljoin(base, href)
        except Exception:
            continue
        low = abs_u.lower()
        if (
            "icetrade.by" not in low
            and "goszakupki.by" not in low
            and not href.startswith("/")
        ):
            continue
        pairs.append((abs_u, text))
    return pairs


def run_http(url: str, timeout: float) -> str:
    import httpx

    headers = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.4",
        "Referer": "https://icetrade.by/",
    }
    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        r = client.get(url, headers=headers)
        r.raise_for_status()
        return r.text


def run_playwright(
    page_url: str,
    storage: str | None,
    timeout_ms: int,
    settle_ms: int,
    headed: bool,
    max_body: int,
) -> tuple[str, list[str], list[str]]:
    from playwright.sync_api import sync_playwright

    xhr_urls: set[str] = set()

    def on_response(resp) -> None:
        try:
            u = resp.url
            if "icetrade.by" not in u and "goszakupki.by" not in u:
                return
            if not (200 <= resp.status < 300):
                return
            headers = resp.headers
            ct = (headers.get("content-type") or "").lower()
            if not any(x in ct for x in ("json", "javascript", "text/plain", "xml")):
                return
            cl = headers.get("content-length")
            if cl and int(cl) > max_body:
                return
            text = resp.text()
            if len(text) > max_body:
                return
            for x in _file_urls_from_text(text, max_len=max_body):
                xhr_urls.add(x)
        except Exception:
            pass

    html_file: set[str] = set()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not headed)
        ctx_opts: dict = {
            "user_agent": UA,
            "locale": "ru-RU",
            "extra_http_headers": {"Accept-Language": "ru-RU,ru;q=0.9,en;q=0.4"},
        }
        if storage:
            ctx_opts["storage_state"] = storage
        context = browser.new_context(**ctx_opts)
        page = context.new_page()
        page.on("response", on_response)
        nav_timeout = max(15_000, timeout_ms)
        page.goto(page_url, wait_until="domcontentloaded", timeout=nav_timeout)
        try:
            page.wait_for_load_state("networkidle", timeout=min(25_000, nav_timeout))
        except Exception:
            pass
        try:
            page.get_by_text(re.compile(r"Аукционные\s+документы", re.I)).first.wait_for(
                timeout=12_000
            )
        except Exception:
            pass
        if settle_ms > 0:
            time.sleep(settle_ms / 1000.0)
        html = page.content()
        browser.close()

    anchors = _collect_anchors(html, page_url)
    html_from_anchors = set(_filter_file_hrefs(anchors))
    html_from_regex = set(_file_urls_from_text(html))
    html_file_sorted = sorted(html_from_anchors | html_from_regex)
    return html, html_file_sorted, sorted(xhr_urls)


def main() -> int:
    parser = argparse.ArgumentParser(description="IceTrade card — извлечь URL вложений")
    parser.add_argument("view_id", help="номер view (например 1336336)")
    parser.add_argument("--json", action="store_true", help="только JSON в stdout")
    parser.add_argument("--http-only", action="store_true", help="только GET httpx, без браузера")
    parser.add_argument("--storage", help="Playwright storage_state.json после входа в ЛК")
    parser.add_argument("--timeout-ms", type=int, default=25_000)
    parser.add_argument("--settle-ms", type=int, default=6_000)
    parser.add_argument("--headed", action="store_true", help="показать окно Chromium")
    parser.add_argument("--max-response-bytes", type=int, default=4_000_000)
    args = parser.parse_args()

    page_url = PAGE_TMPL.format(view_id=args.view_id.strip())
    timeout_s = max(15.0, args.timeout_ms / 1000.0)

    try:
        if args.http_only:
            html = run_http(page_url, timeout_s)
            anchors = _collect_anchors(html, page_url)
            html_urls = set(_filter_file_hrefs(anchors))
            for x in _file_urls_from_text(html):
                html_urls.add(x)
            xhr_urls: list[str] = []
            via = "httpx"
        else:
            html, html_list, xhr_list = run_playwright(
                page_url,
                args.storage,
                args.timeout_ms,
                args.settle_ms,
                args.headed,
                args.max_response_bytes,
            )
            html_urls = set(html_list)
            xhr_urls = xhr_list
            via = "playwright-python"

        all_file = sorted(html_urls | set(xhr_urls))
        out = {
            "ok": True,
            "via": via,
            "page_url": page_url,
            "html_file_urls": sorted(html_urls),
            "xhr_file_urls": xhr_urls,
            "all_file_urls": all_file,
        }
        if args.json:
            print(json.dumps(out, ensure_ascii=False), flush=True)
        else:
            print(json.dumps(out, ensure_ascii=False, indent=2), flush=True)
        return 0
    except Exception as e:
        err = {"ok": False, "error": str(e), "page_url": page_url}
        print(json.dumps(err, ensure_ascii=False), file=sys.stdout, flush=True)
        print(f"fetch_card.py: {e}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
