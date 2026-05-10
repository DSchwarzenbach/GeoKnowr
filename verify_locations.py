"""
verify_locations.py
───────────────────
One-time script to build a verified pool of Street View coordinates.

Uses the Street View METADATA endpoint — this is FREE and does NOT
load any imagery or count against your paid quota.

Usage:
    pip install requests
    python verify_locations.py --key YOUR_GOOGLE_MAPS_API_KEY

Output:
    Overwrites data/locations.json with ~1000 verified coordinates,
    each guaranteed to have Street View coverage within 1 km.
"""

import argparse
import json
import os
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

# ─────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────
TARGET_COUNT   = 1000   # how many verified coords we want
SEARCH_RADIUS  = 1000   # metres — must have coverage within this radius
MAX_WORKERS    = 10     # parallel HTTP requests (keep low to be polite)
RETRY_DELAY    = 0.5    # seconds to wait after a failed/rate-limited request
OUTPUT_PATH    = os.path.join(os.path.dirname(__file__), "data", "locations.json")

METADATA_URL = "https://maps.googleapis.com/maps/api/streetview/metadata"

# ─────────────────────────────────────────────────────────────
# Same weighted region pool as generate_locations.py
# ─────────────────────────────────────────────────────────────
REGIONS = [
    # (lat_min, lat_max, lng_min, lng_max, weight)
    # North America
    (25.0,  49.0, -124.0,  -67.0, 120),  # Contiguous USA
    (44.0,  60.0,  -95.0,  -60.0,  40),  # Eastern Canada
    (19.0,  30.0,  -99.0,  -87.0,  25),  # Mexico
    # Europe
    (35.0,  60.0,  -10.0,   30.0, 180),  # Western/Central Europe
    (50.0,  70.0,   20.0,   60.0,  40),  # Scandinavia + Western Russia
    # South America
    (-33.0,  5.0,  -70.0,  -35.0,  80),  # Brazil, Argentina, Colombia
    # Africa
    (-34.0, 37.0,  -17.0,   51.0,  60),  # Africa
    # Asia
    (20.0,  45.0,  100.0,  145.0,  80),  # East Asia
    ( 1.0,  22.0,   98.0,  140.0,  40),  # SE Asia
    ( 8.0,  37.0,   68.0,   97.0,  40),  # South Asia
    (29.0,  42.0,   26.0,   60.0,  30),  # Middle East / Turkey
    # Oceania
    (-43.0, -10.0, 113.0,  153.0,  60),  # Australia
    (-46.0, -34.0, 166.0,  178.0,  15),  # New Zealand
]

TOTAL_WEIGHT = sum(r[4] for r in REGIONS)


def random_point():
    """Pick a random coordinate weighted by region."""
    pick = random.uniform(0, TOTAL_WEIGHT)
    cumulative = 0
    for region in REGIONS:
        cumulative += region[4]
        if pick <= cumulative:
            lat = round(random.uniform(region[0], region[1]), 6)
            lng = round(random.uniform(region[2], region[3]), 6)
            return {"lat": lat, "lng": lng}
    # Fallback
    r = REGIONS[-1]
    return {"lat": round(random.uniform(r[0], r[1]), 6),
            "lng": round(random.uniform(r[2], r[3]), 6)}


def check_coverage(point, api_key):
    """
    Query the Street View metadata endpoint.
    Returns the snapped {lat, lng} if coverage exists, else None.
    """
    params = {
        "location": f"{point['lat']},{point['lng']}",
        "radius":   SEARCH_RADIUS,
        "key":      api_key,
    }
    try:
        resp = requests.get(METADATA_URL, params=params, timeout=10)
        data = resp.json()
        if data.get("status") == "OK":
            loc = data.get("location", {})
            return {
                "lat": round(loc.get("lat", point["lat"]), 6),
                "lng": round(loc.get("lng", point["lng"]), 6),
            }
        return None
    except Exception:
        return None


def build_verified_pool(api_key, target):
    """
    Continuously generate random candidates and verify them until
    we have `target` confirmed coordinates.
    """
    verified = []
    checked  = 0
    batch_size = MAX_WORKERS * 4  # generate candidates in batches

    print(f"Verifying coordinates (target: {target}, radius: {SEARCH_RADIUS}m)...")
    print("This may take a few minutes. Progress is shown every 50 verifications.\n")

    while len(verified) < target:
        candidates = [random_point() for _ in range(batch_size)]

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = {executor.submit(check_coverage, c, api_key): c for c in candidates}
            for future in as_completed(futures):
                checked += 1
                result = future.result()
                if result:
                    verified.append(result)

                if checked % 50 == 0:
                    hit_rate = len(verified) / checked * 100
                    print(f"  Checked: {checked:>5}  |  Verified: {len(verified):>5}/{target}  |  Hit rate: {hit_rate:.1f}%")

                if len(verified) >= target:
                    break

        # Small pause between batches to avoid hammering the API
        time.sleep(RETRY_DELAY)

    return verified[:target]


def main():
    parser = argparse.ArgumentParser(description="Verify Street View coverage for location pool")
    parser.add_argument("--key", required=True, help="Google Maps API key")
    parser.add_argument("--target", type=int, default=TARGET_COUNT, help=f"Number of coords to verify (default: {TARGET_COUNT})")
    args = parser.parse_args()

    verified = build_verified_pool(args.key, args.target)

    random.shuffle(verified)

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(verified, f)

    print(f"\nDone! Saved {len(verified)} verified coordinates to:")
    print(f"  {OUTPUT_PATH}")
    print("\nNext step: git add data/locations.json && git commit -m 'chore: verified location pool' && git push")


if __name__ == "__main__":
    main()
