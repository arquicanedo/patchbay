# /// script
# dependencies = []
# ///
"""Reproduce the flight-level check of the note (the table in Section 6) from the committed captures.

Run with: uv run check_flight_levels.py
It asserts the figures printed in the note, so the note cannot drift from the data.

Definitions, as in the note:
  level row      a raw row with a numeric barometric altitude of at least 18,000 ft and a climb rate
                 (baro_rate if present, else geom_rate) of at most 100 ft/min in magnitude
  near a level   within 100 ft of a multiple of 1,000 ft
  raw rows       every row in the capture file, including rows whose position is stale (before packing)
  replayed rows  the rows the packing step keeps: position under 6 s old, a range, a numeric altitude
Chance: the altitudes sit on a 25 ft grid, so 9 of the 40 grid points in each 1,000 ft pass the test.
"""
import gzip
import json
from pathlib import Path

PIECES = Path(__file__).resolve().parents[1] / "captures"
CAPTURES = {
    "A (17:45 UTC)": "kewr_20260909T1745Z_push.jsonl.gz",
    "B (15:13 UTC)": "kewr_20260909T1513Z_30min.jsonl.gz",
}
# What the note prints: level rows, rows near a level, aircraft behind the rows.
IN_NOTE = {"A (17:45 UTC)": (8447, 8433, 128), "B (15:13 UTC)": (7892, 7861, 110)}


def near_level(alt):
    r = alt % 1000
    return min(r, 1000 - r) <= 100


def rate(a):
    return a["baro_rate"] if "baro_rate" in a else a.get("geom_rate")


def measure(path):
    rows = [a for line in gzip.open(path, "rt").read().splitlines()[1:] for a in json.loads(line)["aircraft"]]
    numeric = [a for a in rows if isinstance(a.get("alt_baro"), (int, float))]
    out = {"raw rows": len(rows), "raw rows with a numeric altitude": len(numeric),
           "altitudes on the 25 ft grid": sum(a["alt_baro"] % 25 == 0 for a in numeric)}

    def level(sample, limit):
        return [a for a in sample if a["alt_baro"] >= 18000 and rate(a) is not None and abs(rate(a)) <= limit]

    lv = level(numeric, 100)
    out["level rows"] = len(lv)
    out["level rows near a level"] = sum(near_level(a["alt_baro"]) for a in lv)
    out["aircraft behind the level rows"] = len({a["hex"] for a in lv})
    out["level rows exactly on a level"] = sum(a["alt_baro"] % 1000 == 0 for a in lv)
    lv300 = level(numeric, 300)
    out["level rows at 300 ft/min"] = len(lv300)
    out["level rows at 300 ft/min near a level"] = sum(near_level(a["alt_baro"]) for a in lv300)
    kept = [a for a in numeric if a.get("seen_pos", 99) < 6.0 and "r_dst" in a]
    lvk = level(kept, 100)
    out["replayed rows"] = len(kept)
    out["replayed rows without a climb rate"] = sum(rate(a) is None for a in kept)
    out["replayed level rows"] = len(lvk)
    out["replayed level rows near a level"] = sum(near_level(a["alt_baro"]) for a in lvk)
    return out


if __name__ == "__main__":
    for label, name in CAPTURES.items():
        m = measure(PIECES / name)
        print(f"== capture {label}")
        for k, v in m.items():
            print(f"   {k:42s} {v:>8,}")
        pct = lambda a, b: f"{100 * m[a] / m[b]:.2f}%"
        print(f"   share near a level, 100 ft/min, raw        {pct('level rows near a level', 'level rows')}")
        print(f"   share near a level, 300 ft/min, raw        {pct('level rows at 300 ft/min near a level', 'level rows at 300 ft/min')}")
        print(f"   share near a level, 100 ft/min, replayed   {pct('replayed level rows near a level', 'replayed level rows')}")
        print(f"   replayed rows without a climb rate         {pct('replayed rows without a climb rate', 'replayed rows')}")
        assert m["altitudes on the 25 ft grid"] == m["raw rows with a numeric altitude"], "an altitude is off the 25 ft grid"
        assert (m["level rows"], m["level rows near a level"], m["aircraft behind the level rows"]) == IN_NOTE[label], \
            f"capture {label} no longer matches the note"
    print("OK: the figures printed in the note are reproduced.")
