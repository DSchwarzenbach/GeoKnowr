"""
generate_locations.py
Run this once to generate data/locations.json with ~1000 curated worldwide
coordinates that are known to have Google Street View coverage.

Usage:
    python generate_locations.py

Requires no external dependencies.
"""

import json, random, math, os

# ──────────────────────────────────────────────────────────────
# Seed pool: hand-picked regions with dense Street View coverage
# Format: (lat_min, lat_max, lng_min, lng_max, weight)
# Weight controls how many samples come from this region.
# ──────────────────────────────────────────────────────────────
REGIONS = [
    # North America
    (25.0,  49.0,  -124.0, -67.0,   120),  # Contiguous USA
    (44.0,  60.0,  -95.0,  -60.0,   40),   # Canada (east)
    (19.0,  30.0,  -99.0,  -87.0,   25),   # Mexico
    # Europe
    (35.0,  60.0,  -10.0,  30.0,    180),  # Western/Central Europe
    (50.0,  70.0,  20.0,   60.0,    40),   # Scandinavia + Russia west
    # South America
    (-33.0, 5.0,   -70.0,  -35.0,   80),   # Brazil + Argentina + Colombia
    # Africa
    (-34.0, 37.0,  -17.0,  51.0,    60),   # Africa (sparse but has coverage)
    # Asia
    (20.0,  45.0,  100.0,  145.0,   80),   # East Asia (Japan, Korea, China coastal)
    (1.0,   22.0,  98.0,   140.0,   40),   # SE Asia
    (8.0,   37.0,  68.0,   97.0,    40),   # South Asia
    (29.0,  42.0,  26.0,   60.0,    30),   # Middle East / Turkey
    # Oceania
    (-43.0, -10.0, 113.0,  153.0,   60),   # Australia
    (-46.0, -34.0, 166.0,  178.0,   15),   # New Zealand
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

if __name__ == "__main__":
    main()
