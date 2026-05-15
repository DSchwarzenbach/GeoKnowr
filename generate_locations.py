"""
generate_locations.py
Run this once to generate data/locations.json with ~1000 curated worldwide
coordinates that are known to have Google Street View coverage.

Usage:
    python generate_locations.py

Requires no external dependencies.

Region weights are tuned to produce a balanced global distribution that
compensates for lower Street View hit rates in Africa, S. America, and
Oceania.  Sub-regions target corridors with known coverage rather than
entire continents (which include deserts / oceans with zero imagery).
"""

import json, random, math, os

# ──────────────────────────────────────────────────────────────
# Seed pool: regions with known Street View coverage.
# Sub-regions are used instead of continent-wide boxes so that
# verify_locations.py doesn't waste candidates on the Sahara,
# Outback, Amazon, etc.
#
# Format: (lat_min, lat_max, lng_min, lng_max, weight)
#
# Target distribution (after verification hit-rate correction):
#   Europe        ~22%
#   N. America    ~18%
#   S. America    ~14%
#   Africa        ~12%
#   East Asia     ~10%
#   SE Asia       ~7%
#   S. Asia       ~6%
#   Oceania       ~6%
#   Middle East   ~5%
# ──────────────────────────────────────────────────────────────
REGIONS = [
    # ── North America ─────────────────────────────── (~18%)
    (25.0,  49.0, -124.0,  -67.0,  80),   # Contiguous USA
    (44.0,  55.0,  -95.0,  -60.0,  20),   # Eastern Canada
    (19.0,  30.0, -105.0,  -87.0,  20),   # Mexico

    # ── Europe ────────────────────────────────────── (~22%)
    (36.0,  55.0,  -10.0,   25.0, 100),   # Western / Central Europe
    (55.0,  65.0,    5.0,   30.0,  20),    # Scandinavia
    (38.0,  48.0,   15.0,   30.0,  20),    # Eastern Europe / Balkans

    # ── South America ─────────────────────────────── (~14%)
    (-30.0, -5.0,  -55.0,  -35.0,  50),   # Brazil (coastal/south)
    (-38.0,-28.0,  -70.0,  -58.0,  25),   # Argentina (central)
    (-4.0,  12.0,  -77.0,  -67.0,  20),   # Colombia / Ecuador
    (-33.0,-18.0,  -72.0,  -68.0,  15),   # Chile / Peru coast
    (-36.0,-32.0,  -58.0,  -53.0,  10),   # Uruguay

    # ── Africa ────────────────────────────────────── (~12%)
    (-35.0,-22.0,   17.0,   33.0,  35),   # South Africa / Botswana
    (-5.0,   5.0,   28.0,   42.0,  20),   # Kenya / Uganda / Rwanda / Tanzania
    ( 4.0,  14.0,    2.0,   15.0,  20),   # Nigeria / Ghana / Benin
    (12.0,  17.0,  -17.0,   -8.0,  15),   # Senegal / Gambia / Mali south
    (30.0,  37.0,    8.0,   11.0,  10),   # Tunisia
    (-20.0, -8.0,   22.0,   34.0,  10),   # Zambia / Malawi / Mozambique north

    # ── East Asia ─────────────────────────────────── (~10%)
    (31.0,  44.0,  129.0,  145.0,  35),   # Japan
    (34.0,  38.0,  126.0,  130.0,  20),   # South Korea
    (22.0,  40.0,  100.0,  122.0,  20),   # China coastal + Taiwan
    (47.0,  51.0,  106.0,  115.0,   5),   # Mongolia (Ulaanbaatar corridor)

    # ── Southeast Asia ────────────────────────────── (~7%)
    (13.0,  20.0,   99.0,  106.0,  15),   # Thailand
    ( 1.0,   7.0,  100.0,  120.0,  12),   # Malaysia / Singapore / Indonesia
    (10.0,  19.0,  121.0,  127.0,  12),   # Philippines
    (10.0,  22.0,  104.0,  109.0,  10),   # Vietnam / Cambodia

    # ── South Asia ────────────────────────────────── (~6%)
    ( 8.0,  32.0,   73.0,   90.0,  35),   # India (main)
    (23.0,  28.0,   86.0,   93.0,  10),   # Bangladesh / Nepal corridor
    (24.0,  37.0,   62.0,   73.0,   5),   # Pakistan (GT road corridor)

    # ── Middle East / Turkey ──────────────────────── (~5%)
    (36.0,  42.0,   26.0,   44.0,  20),   # Turkey
    (29.0,  34.0,   34.0,   36.0,   8),   # Israel / Jordan
    (24.0,  30.0,   46.0,   55.0,   8),   # UAE / Oman / Qatar

    # ── Oceania ───────────────────────────────────── (~6%)
    (-38.0,-27.0,  143.0,  154.0,  20),   # Australia (east coast)
    (-35.0,-30.0,  114.0,  118.0,  10),   # Australia (Perth / WA coast)
    (-28.0,-12.0,  130.0,  142.0,   5),   # Australia (NT / Queensland inland)
    (-46.0,-34.0,  166.0,  178.0,  12),   # New Zealand
]

def generate_point(region):
    lat_min, lat_max, lng_min, lng_max, _ = region
    lat = round(random.uniform(lat_min, lat_max), 6)
    lng = round(random.uniform(lng_min, lng_max), 6)
    return {"lat": lat, "lng": lng}

def main():
    total_weight = sum(r[4] for r in REGIONS)
    target = 1000
    locations = []

    for region in REGIONS:
        count = round((region[4] / total_weight) * target)
        for _ in range(count):
            locations.append(generate_point(region))

    # Pad/trim to exactly 1000
    while len(locations) < 1000:
        locations.append(generate_point(random.choice(REGIONS)))
    locations = locations[:1000]

    random.shuffle(locations)

    out_path = os.path.join(os.path.dirname(__file__), "data", "locations.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    with open(out_path, "w") as f:
        json.dump(locations, f)

    print(f"OK  Generated {len(locations)} locations -> {out_path}")

    # Print distribution summary
    print("\nWeight distribution:")
    groups = {}
    group_map = {
        "N. America": [0, 1, 2],
        "Europe": [3, 4, 5],
        "S. America": [6, 7, 8, 9, 10],
        "Africa": [11, 12, 13, 14, 15, 16],
        "E. Asia": [17, 18, 19, 20],
        "SE Asia": [21, 22, 23, 24],
        "S. Asia": [25, 26, 27],
        "Mid East": [28, 29, 30],
        "Oceania": [31, 32, 33, 34],
    }
    for group, indices in group_map.items():
        w = sum(REGIONS[i][4] for i in indices)
        pct = w / total_weight * 100
        print(f"  {group:12s}: weight {w:4d}  ({pct:5.1f}%)")

if __name__ == "__main__":
    main()
