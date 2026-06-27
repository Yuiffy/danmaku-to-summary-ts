#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Find duplicate Bilibili uploads by exact title.

This is a lightweight pre/post-upload diagnostic. It searches the public
Bilibili video search endpoint for the current account and groups results by
exact title after removing search-result highlight markup.
"""

import argparse
import json
import os
import re
import sys
import time
from collections import defaultdict

import requests


PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(PROJECT_ROOT, "src", "scripts"))

from config_loader import find_secrets_path  # noqa: E402


DEFAULT_ACCOUNT_MID = 412141275


def load_cookie():
    secrets_path = find_secrets_path()
    with open(secrets_path, "r", encoding="utf-8-sig") as f:
        secrets = json.load(f)
    cookie = secrets.get("bilibili", {}).get("cookie", "")
    if not cookie:
        raise RuntimeError("Missing bilibili.cookie in secrets config")
    return cookie


def strip_search_markup(title):
    return re.sub(r"<[^>]+>", "", title or "").strip()


def search_account_titles(cookie, keyword, account_mid, pages, delay):
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Cookie": cookie,
        "Referer": "https://search.bilibili.com",
    }
    found = defaultdict(list)
    for page in range(1, pages + 1):
        response = requests.get(
            "https://api.bilibili.com/x/web-interface/search/type",
            params={
                "search_type": "video",
                "keyword": keyword,
                "order": "pubdate",
                "page": page,
            },
            headers=headers,
            timeout=15,
        )
        data = response.json()
        if data.get("code") != 0:
            print("search page %d failed: %s" % (page, data.get("message", "")))
            break
        results = (data.get("data") or {}).get("result") or []
        if not results:
            break
        for item in results:
            if int(item.get("mid") or 0) != account_mid:
                continue
            title = strip_search_markup(item.get("title", ""))
            found[title].append(
                {
                    "bvid": item.get("bvid", ""),
                    "pubdate": item.get("pubdate", 0),
                }
            )
        time.sleep(delay)
    return found


def main():
    parser = argparse.ArgumentParser(description="Check duplicate Bilibili uploads by title")
    parser.add_argument("--keyword", default="小岁", help="Search keyword, e.g. 小岁 空洞骑士")
    parser.add_argument("--pages", type=int, default=5, help="Search result pages to scan")
    parser.add_argument("--account-mid", type=int, default=DEFAULT_ACCOUNT_MID, help="Uploader mid")
    parser.add_argument("--delay", type=float, default=1.0, help="Delay between search pages")
    parser.add_argument("--show-recent", type=int, default=30, help="How many recent matched uploads to print")
    args = parser.parse_args()

    found = search_account_titles(
        cookie=load_cookie(),
        keyword=args.keyword,
        account_mid=args.account_mid,
        pages=max(1, args.pages),
        delay=max(0, args.delay),
    )
    duplicates = {title: rows for title, rows in found.items() if len(rows) > 1}

    print("Search keyword: %s" % args.keyword)
    print("Unique titles: %d" % len(found))
    print("Duplicate titles: %d" % len(duplicates))
    if duplicates:
        print("\n=== Duplicates ===")
        for title, rows in sorted(duplicates.items()):
            print("  %s" % title[:100])
            for row in sorted(rows, key=lambda item: item.get("pubdate", 0), reverse=True):
                print("    %s  pubdate=%s" % (row.get("bvid", ""), row.get("pubdate", 0)))

    if args.show_recent > 0:
        recent = []
        for title, rows in found.items():
            for row in rows:
                recent.append((row.get("pubdate", 0), row.get("bvid", ""), title))
        recent.sort(reverse=True)
        print("\n=== Recent Matches ===")
        for pubdate, bvid, title in recent[: args.show_recent]:
            print("  %s | %s | %s" % (bvid, pubdate, title[:100]))


if __name__ == "__main__":
    main()
