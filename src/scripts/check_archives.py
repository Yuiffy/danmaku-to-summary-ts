#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""List Bilibili creator-center archives.

Use this when a submission may be hidden, pending review, rejected, duplicated,
or absent from public search. Unlike search-based checks, this queries the
creator-center archive endpoint with the logged-in account cookie.
"""

import argparse
import datetime as _datetime
import json
import math
import os
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(__file__))
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


def format_time(timestamp):
    try:
        ts = int(timestamp or 0)
    except (TypeError, ValueError):
        ts = 0
    if ts <= 0:
        return "-"
    return _datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


def fetch_page(cookie, account_mid, status, page, page_size):
    response = requests.get(
        "https://member.bilibili.com/x/web/archives",
        params={
            "mid": account_mid,
            "pn": page,
            "ps": page_size,
            "order": "pubdate",
            "status": status,
            "type": 0,
        },
        headers={
            "User-Agent": "Mozilla/5.0",
            "Cookie": cookie,
            "Referer": "https://member.bilibili.com",
        },
        timeout=30,
    )
    data = response.json()
    if data.get("code") != 0:
        raise RuntimeError("archives API failed: code=%s message=%s" % (data.get("code"), data.get("message")))
    return data.get("data") or {}


def archive_matches_keywords(archive, keywords):
    if not keywords:
        return True
    title = archive.get("title", "")
    return any(keyword in title for keyword in keywords)


def print_archive(archive):
    bvid = archive.get("bvid", "")
    title = archive.get("title", "")[:100]
    state = archive.get("state", "")
    shield = archive.get("open_shield", "")
    pubdate = format_time(archive.get("pubdate") or archive.get("ctime"))
    reject_reason = (archive.get("reject_reason") or "").strip()
    suffix = " | reject=%s" % reject_reason[:80] if reject_reason else ""
    print("%s | state=%s shield=%s | %s | %s%s" % (bvid, state, shield, pubdate, title, suffix))


def main():
    parser = argparse.ArgumentParser(description="List Bilibili creator-center archives")
    parser.add_argument("--status", default="pubed", help="Archive status: pubed, not_pubed, is_pubing, all, etc.")
    parser.add_argument("--pages", type=int, default=0, help="Pages to fetch; 0 means all pages reported by API")
    parser.add_argument("--page-size", type=int, default=30, help="Archives per page")
    parser.add_argument("--keyword", action="append", default=[], help="Title keyword filter; repeatable")
    parser.add_argument("--account-mid", type=int, default=DEFAULT_ACCOUNT_MID, help="Uploader mid")
    parser.add_argument("--delay", type=float, default=0.5, help="Delay between pages")
    args = parser.parse_args()

    cookie = load_cookie()
    page_size = max(1, min(args.page_size, 50))
    first = fetch_page(cookie, args.account_mid, args.status, 1, page_size)
    page_info = first.get("page") or {}
    total = int(page_info.get("count") or 0)
    total_pages = max(1, math.ceil(total / page_size)) if total else 1
    max_pages = total_pages if args.pages <= 0 else min(args.pages, total_pages)

    print("status=%s total=%s page_size=%s pages=%s" % (args.status, total, page_size, max_pages))
    archives = first.get("archives") or []
    matched = 0
    for archive in archives:
        if archive_matches_keywords(archive, args.keyword):
            print_archive(archive)
            matched += 1

    for page in range(2, max_pages + 1):
        time.sleep(max(0, args.delay))
        data = fetch_page(cookie, args.account_mid, args.status, page, page_size)
        for archive in data.get("archives") or []:
            if archive_matches_keywords(archive, args.keyword):
                print_archive(archive)
                matched += 1

    if args.keyword:
        print("matched=%d keywords=%s" % (matched, ",".join(args.keyword)))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("[ERROR] %s" % error)
        sys.exit(1)
