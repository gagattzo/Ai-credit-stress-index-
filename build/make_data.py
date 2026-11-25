"""Compose site/data.js from the build outputs plus the borrower board and miner tables.

Run from anywhere: python3 make_data.py
"""
import csv
import json
import pathlib

B = pathlib.Path(__file__).resolve().parent
SITE = B.parent  # repo root


def rows(name):
    with open(B / name) as f:
        return list(csv.DictReader(f))


borrowers = [
    {
        "id": "crwv32", "group": "Neocloud", "borrower": "CoreWeave",
        "instrument": "9.625% unsecured notes due 2032", "price": 74.9, "price_text": "74.9",
        "note": "Intraday low, lowest since issue; yield 16.6%", "date": "2026-11-24", "in_index": "F1",
        "source": "Bloomberg via Yahoo Finance (Trace)",
        "url": "https://finance.yahoo.com/markets/stocks/articles/coreweave-bonds-hit-time-lows-185527465.html",
    },
    {
        "id": "crwv31", "group": "Neocloud", "borrower": "CoreWeave",
        "instrument": "Unsecured notes due 2031", "price": 79.5, "price_text": "79.5",
        "note": "Traded as low as 79.5", "date": "2026-11-04", "in_index": "",
        "source": "Bloomberg (Trace)",
        "url": "https://www.bloomberg.com/news/articles/2026-11-04/coreweave-bonds-hit-new-lows-as-texas-data-centers-in-crosshairs",
    },
    {
        "id": "jupiter", "group": "Oracle-leased campus", "borrower": "Project Jupiter, New Mexico",
        "instrument": "Construction loans (ING auction)", "price": 85, "price_text": "<85",
        "note": "Bids came in below the mid-80s; shown at the bound", "date": "2026-11-20", "in_index": "F3",
        "source": "Bloomberg via Briefs",
        "url": "https://www.briefs.co/news/ing-s-500-million-data-center-loan-auction-underwhelms-shift/",
    },
    {
        "id": "michigan", "group": "Oracle-leased campus", "borrower": "Saline Township, Michigan",
        "instrument": "7.5% secured notes due 2045 (Related Digital)", "price": 88, "price_text": "~88",
        "note": "Issued at 98.75 in April 2026", "date": "2026-10-28", "in_index": "",
        "source": "Bloomberg via CRE Daily (Trace)",
        "url": "https://www.credaily.com/briefs/pimco-cut-ai-debt-stakes-by-half-and-skirted-losses/",
    },
    {
        "id": "beignet", "group": "Hyperscaler project bond", "borrower": "Meta Hyperion, Louisiana",
        "instrument": "6.581% secured notes due 2049 (Beignet Investor), rated A+", "price": 91, "price_text": "91",
        "note": "Issued at par in Oct 2025, peaked above 110; yield 7.55%, about 230 bp over Treasuries vs 185 bp at launch", "date": "2026-09-28", "in_index": "",
        "source": "Reuters column via The Edge",
        "url": "https://theedgemalaysia.com/node/819893",
    },
]

miners = [
    {"name": "IREN", "debt": "$3.7bn of convertible notes", "week": -34.9},
    {"name": "TeraWulf", "debt": "$5.7bn total debt, incl. $3.2bn of 7.75% secured notes due 2030", "week": -21.9},
    {"name": "Cipher Digital", "debt": "$1.7bn of 7.125% secured notes due 2030", "week": -20.8},
]
miners_meta = {
    "week_to": "2026-11-20",
    "debt_source": "CoinShares via Startup Fortune (20 Nov)",
    "debt_url": "https://startupfortune.com/bitcoin-miners-turned-ai-landlords-now-carry-billions-in-debt-into-the-ecbs-subprime-warning/",
    "week_source": "TECHi, from Nasdaq prices (week to 20 Nov)",
    "week_url": "https://www.techi.com/bitcoin-miners-ai-data-centers-move-with-ai-stocks-not-bitcoin-iren/",
}

data = {
    "inputs": json.load(open(B / "inputs.json"))["rows"],
    "sensitivity": json.load(open(B / "sensitivity.json"))["rows"],
    "loan_prints": rows("loan_prints.csv"),
    "series": rows("series.csv"),
    "context": rows("context.csv"),
    "edition": rows("edition.csv"),
    "borrowers": borrowers,
    "miners": miners,
    "miners_meta": miners_meta,
}
out = "window.ACSI_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/") + ";\n"
(SITE / "data.js").write_text(out)
print("wrote", SITE / "data.js", len(out), "bytes")
