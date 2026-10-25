# /// script
# dependencies = []
# ///
"""The interval facts of the musical-choices section, reproduced from the code and the captures.

Run with: uv run check_intervals.py
It asserts the figures the note prints.

1. Scales: read from the SCALES table of the editor (app.js). For each scale, does any pair of its
   notes make a minor second or its inversion the major seventh (interval class 1 or 11), or a tritone (class 6)?
2. Flight levels: the example keeps the ten nearest aircraft in level flight (range <= 120 NM, 18,000 to
   45,000 ft, climb rate present and at most 300 ft/min, position under 6 s old). For one drone per
   aircraft at s semitones per 1,000 ft, how often do two drones stand on adjacent levels, and what share of
   pairs fall in the harsh classes (minor second, tritone, major seventh)? The scale's range limit is ignored.
   Rounding is half up, as Math.round in the editor.
3. Ground: read from the CHORDS, GROUNDS and scale constants of the editor (app.js). Do the tones of any chord
   make a harsh interval class with each other (so that aircraft in level flight, which sound chord tones, cannot
   sound one)? Can a passing note (a scale note that is not a chord tone, sounded by a climbing or descending
   aircraft) make one with a chord tone (so that the claim must be limited to level flight)?
"""
import gzip
import itertools
import json
import math
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
APP = ROOT / "editor" / "app.js"
CAPTURES = {"A": "kewr_20260909T1745Z_push.jsonl.gz", "B": "kewr_20260909T1513Z_30min.jsonl.gz"}
HARSH = {1, 6, 11}


def half_up(x):
    return math.floor(x + 0.5)


def scales():
    block = re.search(r"const SCALES = \{(.*?)\};", APP.read_text(), re.S).group(1)
    return {name: [int(n) for n in notes.split(",")]
            for name, notes in re.findall(r"'([^']+)': \[([0-9, ]+)\]", block)}


def classes(degrees):
    return {(b - a) % 12 for a, b in itertools.combinations(degrees, 2)}


def ground():
    src = APP.read_text()
    minor, harmonic = (list(map(int, m.split(","))) for m in re.search(
        r"const MINOR = \[([0-9, ]+)\], HARMONIC_MINOR = \[([0-9, ]+)\];", src).groups())
    scale_of = {"MINOR": minor, "HARMONIC_MINOR": harmonic}
    block = re.search(r"const CHORDS = \{(.*?)\n\};", src, re.S).group(1)
    chords = {n: (list(map(int, t.split(","))), scale_of[s])
              for n, t, s in re.findall(r"(\w+): \{ root: \d+, tones: \[([0-9, ]+)\], scale: (\w+) \}", block)}
    cycles = {n: re.findall(r"'(\w+)'", c) for n, c in re.findall(r"(\w+): (\[[^\]]*\])", re.search(
        r"const GROUNDS = \{(.*?)\};", src, re.S).group(1))}
    return chords, cycles


def near_level(alt):
    # at 4 semitones per 1,000 ft, an altitude within 125 ft (half a semitone) of a flight level rounds to that level's note
    off = (alt - 18000) % 1000
    return min(off, 1000 - off) < 125


def level_pairs(path):
    frames = [json.loads(l) for l in gzip.open(path, "rt").read().splitlines()[1:]]
    stats = {s: [0, 0] for s in (1, 2, 3, 4)}  # harsh pairs, all pairs
    on_level_harsh = 0  # harsh pairs at 4 semitones per level in which both aircraft round to a level
    with_pair = adjacent = counts = full = fewest = 0
    fewest = 99
    for fr in frames:
        rows = []
        for a in fr["aircraft"]:
            alt = a.get("alt_baro")
            if a.get("seen_pos", 99) >= 6.0 or "r_dst" not in a or not isinstance(alt, (int, float)):
                continue
            vr = a["baro_rate"] if "baro_rate" in a else a.get("geom_rate")
            if vr is None or abs(vr) > 300 or a["r_dst"] > 120 or not 18000 <= alt <= 45000:
                continue
            rows.append((a["r_dst"], alt))
        rows = sorted(rows)[:10]
        counts += len(rows)
        full += len(rows) == 10
        fewest = min(fewest, len(rows))
        with_pair += len(rows) >= 2
        adj = False
        for (_, a1), (_, a2) in itertools.combinations(rows, 2):
            adj |= abs(half_up(a1 / 1000) - half_up(a2 / 1000)) == 1
            for s in stats:
                d = abs(half_up((a1 - 18000) / 1000 * s) - half_up((a2 - 18000) / 1000 * s)) % 12
                stats[s][0] += d in HARSH
                stats[s][1] += 1
                if s == 4 and d in HARSH:
                    on_level_harsh += near_level(a1) and near_level(a2)
        adjacent += adj
    return {"frames": len(frames), "mean drones": counts / len(frames), "frames with ten": full, "fewest drones": fewest, "frames with a pair": with_pair,
            "frames with an adjacent pair": adjacent, "harsh share": {s: v[0] / v[1] for s, v in stats.items()},
            "harsh pairs at 4": stats[4][0], "of which both on a level": on_level_harsh}


if __name__ == "__main__":
    sc = scales()
    assert len(sc) == 9, "the editor no longer has nine scales"
    for name, deg in sc.items():
        print(f"{name:26s} {len(deg):2d} notes  m2/M7 {bool(classes(deg) & {1, 11})!s:5}  tritone {6 in classes(deg)}")
    chords, cycles = ground()
    assert len(chords) == 4 and set(cycles) == {"lament", "dominant", "vamp", "home"}, (chords, cycles)
    assert all(c in chords for cycle in cycles.values() for c in cycle)
    passing_harsh = []
    for name, (tones, scale) in chords.items():
        tone_pcs = [t % 12 for t in tones]
        among_tones = classes(tone_pcs) | classes(tone_pcs[::-1])
        passing = [p for p in scale if p not in tone_pcs]
        beside = {p: sorted({(p - t) % 12 for t in tone_pcs} & HARSH) for p in passing}
        passing_harsh += [(name, p, h) for p, h in beside.items() if h]
        print(f"chord {name:4s} tones {tone_pcs} harsh among tones {sorted(among_tones & HARSH)}  "
              f"passing notes {passing}  harsh against a chord tone {beside}")
        assert not among_tones & HARSH, f"chord {name} holds a harsh interval"
    assert passing_harsh, "no passing note makes a harsh interval, so the limit to level flight is unneeded"
    got = {}
    for label, f in CAPTURES.items():
        m = level_pairs(ROOT / "captures" / f)
        got[label] = m
        print(f"== capture {label}: {m['frames']} frames, {m['frames with ten']} with ten drones (fewest {m['fewest drones']}), "
              f"{m['frames with an adjacent pair']} of {m['frames with a pair']} frames have an adjacent-level pair "
              f"({100 * m['frames with an adjacent pair'] / m['frames with a pair']:.1f}%)")
        print("   harsh share of pairs by semitones per level:",
              {s: f"{100 * v:.1f}%" for s, v in m["harsh share"].items()})
    # What the note prints.
    assert all(g["frames with ten"] / g["frames"] > 0.95 for g in got.values()), "the selection no longer fills ten drones"
    pct = {k: round(100 * g["frames with an adjacent pair"] / g["frames with a pair"]) for k, g in got.items()}
    assert pct == {"A": 94, "B": 99}, pct
    assert [round(100 * g["harsh share"][1]) for g in got.values()] == [27, 25]
    assert all(g["harsh share"][4] < 0.005 for g in got.values())
    # the remainder at 4 semitones per level comes only from aircraft off a level, as the note says
    assert all(g["harsh pairs at 4"] > 0 and g["of which both on a level"] == 0 for g in got.values()), \
        {k: (g["harsh pairs at 4"], g["of which both on a level"]) for k, g in got.items()}
    print(f"Ground: no chord tone pair is a minor second, tritone or major seventh; {len(passing_harsh)} (chord, passing note) cases are.")
    print("OK: the figures printed in the note are reproduced.")
