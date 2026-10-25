# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Census of everything a 1090 MHz ADS-B receiver senses, for the SIGNALS table.

Three steps, so the table's numbers are measured and reproducible rather than typed in:

    uv run census/census.py record --seconds 1800 --out raw.jsonl
    uv run census/census.py measure --input raw.jsonl --out census.json
    uv run census/census.py selftest

`capture.py` keeps only the fields the sonifier reads. `record` keeps aircraft.json
UNTRIMMED, because the point is to find out what else the receiver hears.

The raw file carries lat/lon next to r_dst/r_dir, which together locate the antenna to
about 10 m. Keep it out of the repo; census.json is aggregate and carries no position,
callsign, registration or ICAO address.

Definitions the table depends on, all measured on aircraft that were HEARD in the frame
(`seen` < 5 s), because readsb keeps silent aircraft in the list for minutes and their
frozen values would read as "holds perfectly still":

  still     share of consecutive frame pairs where the value moved by no more than `tol`
  dwell     how long a value stays within +-tol of where a stretch started, duration-weighted
            (the length of the stretch a random moment falls in), in seconds
  within    share of the field's variance that is one aircraft changing over time; the
            rest is different aircraft being different
  assoc     association between two fields across aircraft, in 0..1. |Spearman| for two
            linear fields, Mardia's R for angle-vs-linear, |Jammalamadaka-Sarma| for two
            angles. Not the same statistic, so read it as strength, not as a shared scale
"""

import argparse
import collections
import json
import math
import re
import sys
import time
import urllib.request

import numpy as np

DEFAULT_URL = "http://localhost:8080"

# readsb regenerates aircraft.json every 5 s (see README "The tempo comes from the hardware").
FRAME_LO, FRAME_HI = 3.5, 7.0
LIVE_SEEN_SEC = 5.0
POS_SEEN_SEC = 6.0
CLUSTER_ASSOC = 0.5
MIN_PAIR_N = 30
HIST_BINS = 24

# The smallest change worth a note. Chosen per field, printed in the table, and the reason
# is physical: below these the value is inside the receiver's own scatter or a pilot's
# routine drift. Everything on the "holds still" and "dwell" columns depends on them.
TOL = {
    "rssi": 3.0,
    "msg_rate": 2.0,
    "r_dst": 0.5,
    "r_dir": 2.0,
    "alt_baro": 100.0,
    "alt_geom": 100.0,
    "geom_minus_baro": 50.0,
    "baro_rate": 128.0,
    "geom_rate": 128.0,
    "gs": 5.0,
    "track": 2.0,
    "nav_altitude_mcp": 100.0,
    "nav_heading": 2.0,
    "nav_qnh": 0.5,
    "ias": 5.0,
    "mach": 0.01,
    "mag_heading": 2.0,
    "tas": 5.0,
    "roll": 2.0,
    "track_rate": 0.2,
}

# How long since the receiver last heard the aircraft. Measured over every listed
# aircraft-frame, because dropping the silent ones would erase the thing being measured.
AGE_KEYS = ("seen", "seen_pos")

CIRCULAR = {"r_dir", "track", "nav_heading", "mag_heading", "true_heading"}
POSITION_DERIVED = {"r_dst", "r_dir", "lat", "lon"}

# Integer-valued fields where a broadcast quantum is expected. The largest candidate that
# 99% of READINGS are multiples of is reported. Weighting by reading, not by distinct value,
# matters: a few aircraft reporting finer values from a different source each add unique
# values and would otherwise outvote the millions of readings on the real grid.
GRID_CANDIDATES = (1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 50, 64, 100)

CODE_FIELDS = ("version", "nic", "nic_baro", "nac_p", "nac_v", "sil", "gva", "sda")


def fetch(url, timeout=15.0):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def record(args):
    base = args.url.rstrip("/")
    receiver = fetch(f"{base}/data/receiver.json")
    deadline = time.time() + args.seconds
    frames = 0
    last_now = None
    with open(args.out, "w") as fh:
        fh.write(json.dumps({"kind": "pitchaxis-census-raw", "v": 1, "receiver": receiver}) + "\n")
        while time.time() < deadline:
            try:
                raw = fetch(f"{base}/data/aircraft.json")
            except Exception as exc:
                print(f"poll failed: {exc}", file=sys.stderr)
                continue
            if raw.get("now") == last_now:
                continue
            last_now = raw["now"]
            fh.write(json.dumps(raw) + "\n")
            fh.flush()
            frames += 1
            if frames % 60 == 0:
                print(f"{frames} frames, {len(raw.get('aircraft', []))} aircraft", file=sys.stderr)
    print(f"wrote {frames} frames to {args.out}", file=sys.stderr)


# ---------------------------------------------------------------- estimators


def wrap180(d):
    return (np.asarray(d, dtype=float) + 180.0) % 360.0 - 180.0


def weighted_median(values, weights):
    order = np.argsort(values)
    v = np.asarray(values, dtype=float)[order]
    w = np.asarray(weights, dtype=float)[order]
    cum = np.cumsum(w)
    return float(v[np.searchsorted(cum, cum[-1] / 2.0)])


def weighted_quantile(values, weights, q):
    order = np.argsort(values)
    v = np.asarray(values, dtype=float)[order]
    w = np.asarray(weights, dtype=float)[order]
    cum = np.cumsum(w)
    return float(v[min(np.searchsorted(cum, cum[-1] * q), len(v) - 1)])


def dwell_seconds(series, tol, circular, dt=5.0):
    """series: list of (t, value) for ONE aircraft, time-ordered. Returns stretch durations.

    A stretch ends when the value leaves +-tol of the stretch's FIRST value, or when a
    frame is missing. Measuring from the start catches slow drift that frame-to-frame
    differences would miss.
    """
    out = []
    if not series:
        return out
    start_t, start_v = series[0]
    last_t = start_t
    for t, v in series[1:]:
        gap = t - last_t
        d = abs(float(wrap180(v - start_v))) if circular else abs(v - start_v)
        if gap > FRAME_HI or d > tol:
            out.append(last_t - start_t + dt)
            start_t, start_v = t, v
        last_t = t
    out.append(last_t - start_t + dt)
    return out


def grid_step(values):
    v = np.round(np.asarray(values, dtype=float)).astype(np.int64)
    if len(np.unique(v)) < 8:
        return None
    best = None
    for c in GRID_CANDIDATES:
        if np.mean(v % c == 0) >= 0.99:
            best = c
    return best if best and best > 1 else None


def rank(x):
    x = np.asarray(x, dtype=float)
    order = np.argsort(x, kind="mergesort")
    r = np.empty(len(x))
    r[order] = np.arange(len(x))
    for v in np.unique(x):
        m = x == v
        if m.sum() > 1:
            r[m] = r[m].mean()
    return r


def corr(a, b):
    a = a - a.mean()
    b = b - b.mean()
    den = math.sqrt(float((a * a).sum() * (b * b).sum()))
    return float((a * b).sum() / den) if den > 0 else 0.0


def assoc_lin_lin(x, y):
    return abs(corr(rank(x), rank(y)))


def assoc_circ_lin(theta_deg, y):
    th = np.deg2rad(theta_deg)
    ry = rank(y)
    c, s = np.cos(th), np.sin(th)
    rxc, rxs, rcs = corr(ry, c), corr(ry, s), corr(c, s)
    den = 1.0 - rcs * rcs
    if den <= 1e-9:
        return 0.0
    return math.sqrt(max(0.0, (rxc * rxc + rxs * rxs - 2 * rxc * rxs * rcs) / den))


def circ_mean(theta_deg):
    th = np.deg2rad(theta_deg)
    return math.atan2(np.sin(th).mean(), np.cos(th).mean())


def assoc_circ_circ(a_deg, b_deg):
    sa = np.sin(np.deg2rad(a_deg) - circ_mean(a_deg))
    sb = np.sin(np.deg2rad(b_deg) - circ_mean(b_deg))
    den = math.sqrt(float((sa * sa).sum() * (sb * sb).sum()))
    return abs(float((sa * sb).sum() / den)) if den > 0 else 0.0


def assoc(kind_a, a, kind_b, b):
    if kind_a == "circular" and kind_b == "circular":
        return assoc_circ_circ(a, b)
    if kind_a == "circular":
        return assoc_circ_lin(a, b)
    if kind_b == "circular":
        return assoc_circ_lin(b, a)
    return assoc_lin_lin(a, b)


def cluster_average(matrix, cut):
    """Average-linkage groups where mean association inside a group is >= cut."""
    n = len(matrix)
    groups = [[i] for i in range(n)]

    def mean_link(g1, g2):
        return float(np.mean([matrix[i][j] for i in g1 for j in g2]))

    while len(groups) > 1:
        best, pair = -1.0, None
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                m = mean_link(groups[i], groups[j])
                if m > best:
                    best, pair = m, (i, j)
        if best < cut:
            break
        i, j = pair
        groups[i] = groups[i] + groups[j]
        del groups[j]
    return groups


def entropy_bits(counter):
    total = sum(counter.values())
    return -sum(c / total * math.log2(c / total) for c in counter.values() if c) if total else 0.0


# ---------------------------------------------------------------- loading


def load_raw(path):
    header, frames = None, []
    with open(path) as fh:
        for line in fh:
            d = json.loads(line)
            if d.get("kind") == "pitchaxis-census-raw":
                header = d
            else:
                frames.append(d)
    return header, frames


def build_tracks(frames):
    tracks = collections.defaultdict(list)
    for fi, fr in enumerate(frames):
        for ac in fr["aircraft"]:
            tracks[ac["hex"]].append((fr["now"], fi, ac))
    return tracks


def is_live(ac):
    return ac.get("seen", 99.0) < LIVE_SEEN_SEC


def fresh_for(key, ac):
    if key in AGE_KEYS:
        return True
    if not is_live(ac):
        return False
    if key in POSITION_DERIVED and ac.get("seen_pos", 99.0) >= POS_SEEN_SEC:
        return False
    return True


def value_of(key, ac):
    """The numeric value of a field for one aircraft-frame, or None."""
    if key == "geom_minus_baro":
        a, b = ac.get("alt_geom"), ac.get("alt_baro")
        return a - b if isinstance(a, (int, float)) and isinstance(b, (int, float)) else None
    v = ac.get(key)
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


# ---------------------------------------------------------------- measure


def series_for(tracks, key):
    """Per aircraft: list of (t, value) over live frames; for msg_rate a derived rate."""
    out = {}
    for hx, obs in tracks.items():
        if key == "msg_rate":
            s = []
            prev = None
            for t, _fi, ac in obs:
                if not is_live(ac) or "messages" not in ac:
                    prev = None
                    continue
                if prev is not None:
                    dt = t - prev[0]
                    dm = ac["messages"] - prev[1]
                    if FRAME_LO <= dt <= FRAME_HI and dm >= 0:
                        s.append((t, dm / dt))
                prev = (t, ac["messages"])
        else:
            s = []
            for t, _fi, ac in obs:
                if not fresh_for(key, ac):
                    continue
                v = value_of(key, ac)
                if v is not None:
                    s.append((t, v))
        if s:
            out[hx] = s
    return out


def measure_numeric(key, tracks, live_frames_total, distinct_total, listed_frames_total):
    circular = key in CIRCULAR
    if key in AGE_KEYS:
        live_frames_total = listed_frames_total
    tol = TOL.get(key)
    ser = series_for(tracks, key)
    if not ser:
        return {"kind": "circular" if circular else "linear", "n_ac": 0, "share_ac": 0.0, "n_frames": 0, "share_frames": 0.0}
    vals = np.concatenate([[v for _, v in s] for s in ser.values()])
    n_frames = len(vals)
    entry = {
        "kind": "circular" if circular else "linear",
        "n_ac": len(ser),
        "share_ac": len(ser) / distinct_total,
        "n_frames": n_frames,
        "share_frames": n_frames / live_frames_total,
        "tol": tol,
    }
    if circular:
        th = np.deg2rad(vals)
        entry["conc_R"] = float(math.hypot(np.sin(th).mean(), np.cos(th).mean()))
        entry["q"] = {"min": 0.0, "max": 360.0}
        lo, hi = 0.0, 360.0
        edges = np.linspace(lo, hi, HIST_BINS + 1)
        counts, _ = np.histogram(vals % 360.0, bins=edges)
    else:
        pct = np.percentile(vals, [1, 5, 25, 50, 75, 95, 99])
        entry["q"] = {
            "min": float(vals.min()), "p1": float(pct[0]), "p5": float(pct[1]), "p25": float(pct[2]),
            "p50": float(pct[3]), "p75": float(pct[4]), "p95": float(pct[5]), "p99": float(pct[6]),
            "max": float(vals.max()),
        }
        entry["mean"] = float(vals.mean())
        entry["sd"] = float(vals.std())
        lo, hi = float(np.percentile(vals, 0.5)), float(np.percentile(vals, 99.5))
        if hi <= lo:
            hi = lo + 1.0
        edges = np.linspace(lo, hi, HIST_BINS + 1)
        counts, _ = np.histogram(np.clip(vals, lo, hi), bins=edges)
        # Variance decomposition. Undefined for angles, so linear fields only.
        gm = vals.mean()
        between = sum(len(s) * (np.mean([v for _, v in s]) - gm) ** 2 for s in ser.values()) / n_frames
        total = float(vals.var())
        entry["share_within"] = float(max(0.0, 1.0 - between / total)) if total > 0 else None
    entry["hist"] = {"lo": float(edges[0]), "hi": float(edges[-1]), "counts": [int(c) for c in counts]}
    entry["distinct"] = int(len(np.unique(vals)))
    if key in ("alt_baro", "alt_geom", "baro_rate", "geom_rate", "nav_altitude_mcp", "geom_minus_baro"):
        entry["grid"] = grid_step(vals)
        if entry["grid"]:
            entry["off_grid_share"] = float(np.mean(np.round(vals).astype(np.int64) % entry["grid"] != 0))
    if key in ("baro_rate", "geom_rate"):
        entry["zero_share"] = float(np.mean(vals == 0))
    uniq = np.unique(vals)
    if key == "nav_qnh":
        # DO-260B carries the pressure setting as 800 hPa + n * 0.8 hPa.
        entry["grid_0p8_share"] = float(np.mean(np.abs((uniq - 800.0) / 0.8 - np.round((uniq - 800.0) / 0.8)) < 0.02))
    if key == "nav_heading":
        # DO-260B carries the selected heading in 180/256 degree steps.
        step = 180.0 / 256.0
        entry["grid_0p703_share"] = float(np.mean(np.abs(uniq / step - np.round(uniq / step)) < 0.02))

    if tol is not None:
        diffs = []
        runs = []
        for s in ser.values():
            for (t0, v0), (t1, v1) in zip(s, s[1:]):
                if FRAME_LO <= t1 - t0 <= FRAME_HI:
                    diffs.append(float(wrap180(v1 - v0)) if circular else v1 - v0)
            runs.extend(dwell_seconds(s, tol, circular))
        if diffs:
            ad = np.abs(np.array(diffs))
            moved = ad[ad > tol]
            entry["hold"] = {
                "pairs": int(len(ad)),
                "still": float(np.mean(ad <= tol)),
                "move_med": float(np.median(moved)) if len(moved) else 0.0,
                "move_p95_all": float(np.percentile(ad, 95)),
            }
        if runs:
            r = np.array(runs)
            entry["dwell"] = {
                "n": int(len(r)),
                "med_s": weighted_median(r, r),
                "p90_s": weighted_quantile(r, r, 0.9),
            }
    if key == "rssi":
        # Second difference removes a linear trend, so what is left is jitter. For white
        # noise of sd s, the second difference has sd s*sqrt(6).
        sd2 = []
        for s in ser.values():
            v = np.array([x for _, x in s])
            if len(v) >= 5:
                sd2.append(np.diff(v, n=2))
        if sd2:
            d2 = np.concatenate(sd2)
            entry["jitter_sd"] = float(np.std(d2) / math.sqrt(6.0))
    return entry


def measure_categorical(key, tracks, distinct_total, live_frames_total, top=6):
    per_ac = {}
    changes = 0
    frames_with = 0
    for hx, obs in tracks.items():
        seq = [ac[key] for _t, _fi, ac in obs if key in ac and is_live(ac) and ac[key] not in (None, "")]
        if not seq:
            continue
        frames_with += len(seq)
        per_ac[hx] = collections.Counter(seq).most_common(1)[0][0]
        changes += sum(1 for a, b in zip(seq, seq[1:]) if a != b)
    counter = collections.Counter(per_ac.values())
    n = len(per_ac)
    return {
        "n_ac": n,
        "share_ac": n / distinct_total,
        "share_frames": frames_with / live_frames_total,
        "distinct": len(counter),
        "entropy_bits": entropy_bits(counter),
        "top": [(str(k).strip() if not isinstance(k, list) else str(k), c / n) for k, c in counter.most_common(top)],
        "changes": changes,
    }


def measure_nav_modes(tracks, live_frames_total):
    modes = collections.Counter()
    combos = collections.Counter()
    frames = 0
    for obs in tracks.values():
        for _t, _fi, ac in obs:
            if "nav_modes" in ac and is_live(ac):
                frames += 1
                combos[tuple(sorted(ac["nav_modes"]))] += 1
                for m in ac["nav_modes"]:
                    modes[m] += 1
    return {
        "share_frames": frames / live_frames_total,
        "mode_share": {m: c / frames for m, c in modes.most_common()},
        "combos": len(combos),
        "entropy_bits": entropy_bits(combos),
        "top_combos": [(list(k), c / frames) for k, c in combos.most_common(4)],
    }


def measure_flag(key, tracks, live_frames_total):
    n = on = 0
    for obs in tracks.values():
        for _t, _fi, ac in obs:
            if key in ac and is_live(ac):
                n += 1
                on += 1 if ac[key] else 0
    return {"share_frames": n / live_frames_total, "share_on": on / n if n else 0.0}


def measure_identity(tracks, distinct_total):
    us_hex = 0
    airline = 0
    called = 0
    digits = collections.Counter()
    years = []
    type_counter = collections.Counter()
    for hx, obs in tracks.items():
        if hx.startswith("~"):
            continue
        # A0..AF is the US block of the 24-bit ICAO address space.
        us_hex += 1 if hx[0] == "a" else 0
        flights = [ac["flight"].strip() for _t, _fi, ac in obs if ac.get("flight", "").strip()]
        if flights:
            called += 1
            f = collections.Counter(flights).most_common(1)[0][0]
            m = re.fullmatch(r"([A-Z]{3})(\d{1,4})[A-Z]{0,2}", f)
            if m:
                airline += 1
                digits[len(m.group(2))] += 1
        for _t, _fi, ac in obs:
            if "year" in ac:
                try:
                    years.append(int(ac["year"]))
                except ValueError:
                    pass
                break
    return {
        "us_hex_share": us_hex / distinct_total,
        "callsign_share_ac": called / distinct_total,
        "airline_style_of_called": airline / called if called else 0.0,
        "flight_number_digits": {str(k): v / airline for k, v in sorted(digits.items())} if airline else {},
        "year_q": [float(x) for x in np.percentile(years, [5, 50, 95])] if years else None,
        "year_n": len(years),
    }


def measure_sky(frames):
    counts = []
    live = []
    msg_rate = []
    prev = None
    for fr in frames:
        counts.append(len(fr["aircraft"]))
        live.append(sum(1 for ac in fr["aircraft"] if is_live(ac)))
        if prev is not None and "messages" in fr and "messages" in prev:
            dt = fr["now"] - prev["now"]
            if FRAME_LO <= dt <= FRAME_HI:
                msg_rate.append((fr["messages"] - prev["messages"]) / dt)
        prev = fr
    nows = np.array([fr["now"] for fr in frames])
    dts = np.diff(nows)

    def stats(x):
        x = np.array(x, dtype=float)
        # Lag at which the series has decorrelated to 0.5, in frames.
        xc = x - x.mean()
        ac0 = float((xc * xc).sum())
        half = None
        if ac0 > 0:
            for lag in range(1, len(x) // 2):
                if float((xc[:-lag] * xc[lag:]).sum() / ac0) < 0.5:
                    half = lag
                    break
        return {
            "mean": float(x.mean()), "sd": float(x.std()), "cv": float(x.std() / x.mean()) if x.mean() else None,
            "min": float(x.min()), "max": float(x.max()), "half_life_frames": half,
        }

    return {
        "frames": len(frames),
        "duration_s": float(nows[-1] - nows[0]),
        "period_median_s": float(np.median(dts)),
        "period_min_s": float(dts.min()),
        "period_max_s": float(dts.max()),
        "listed": stats(counts),
        "heard": stats(live),
        "msg_rate_total": stats(msg_rate),
    }


def measure_traffic_events(tracks, frames):
    dur_min = (frames[-1]["now"] - frames[0]["now"]) / 60.0
    last_fi = len(frames) - 1
    entries = exits = 0
    lengths = []
    tracked = 0
    for obs in tracks.values():
        live = [(t, fi) for t, fi, ac in obs if is_live(ac)]
        if not live:
            continue
        tracked += 1
        entered = live[0][1] > 0
        left = live[-1][1] < last_fi
        entries += 1 if entered else 0
        exits += 1 if left else 0
        # Only tracks whose start AND end fall inside the capture have a true length.
        # This biases short, since long passages are the ones cut off by the window.
        if entered and left:
            lengths.append(live[-1][0] - live[0][0] + 5.0)
    return {
        "entries_per_min": entries / dur_min,
        "exits_per_min": exits / dur_min,
        "complete_tracks": len(lengths),
        "complete_share": len(lengths) / tracked if tracked else None,
        "time_in_view_med_s": float(np.median(lengths)) if lengths else None,
        "time_in_view_p90_s": float(np.percentile(lengths, 90)) if lengths else None,
    }


ASSOC_KEYS = [
    "rssi", "msg_rate", "r_dst", "r_dir", "alt_baro", "alt_geom", "baro_rate", "geom_rate", "gs", "track",
    "nav_altitude_mcp", "nav_heading", "nav_qnh", "ias", "mach", "mag_heading", "tas", "roll",
    "version", "nic", "nac_p", "nac_v", "sil", "gva", "sda",
]


def per_aircraft_summary(tracks, key):
    out = {}
    for hx, s in series_for(tracks, key).items():
        v = np.array([x for _, x in s])
        out[hx] = float(math.degrees(circ_mean(v)) % 360.0) if key in CIRCULAR else float(np.median(v))
    return out


def measure_assoc(tracks):
    summaries = {k: per_aircraft_summary(tracks, k) for k in ASSOC_KEYS}
    keys = [k for k in ASSOC_KEYS if len(summaries[k]) >= MIN_PAIR_N]
    n = len(keys)
    m = [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]
    sign = [[0] * n for _ in range(n)]
    ns = [[0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            common = [h for h in summaries[keys[i]] if h in summaries[keys[j]]]
            ns[i][j] = ns[j][i] = len(common)
            if len(common) < MIN_PAIR_N:
                continue
            a = np.array([summaries[keys[i]][h] for h in common])
            b = np.array([summaries[keys[j]][h] for h in common])
            ka = "circular" if keys[i] in CIRCULAR else "linear"
            kb = "circular" if keys[j] in CIRCULAR else "linear"
            m[i][j] = m[j][i] = assoc(ka, a, kb, b)
            if ka == "linear" and kb == "linear":
                sign[i][j] = sign[j][i] = 1 if corr(rank(a), rank(b)) >= 0 else -1
    groups = cluster_average(m, CLUSTER_ASSOC)
    return {
        "keys": keys, "matrix": m, "sign": sign, "pair_n": ns, "cut": CLUSTER_ASSOC,
        "groups": [[keys[i] for i in g] for g in groups],
        "group_count_by_cut": {f"{c:g}": len(cluster_average(m, c)) for c in (0.3, 0.4, 0.5, 0.6, 0.7)},
    }


def measure(args):
    header, frames = load_raw(args.input)
    tracks = build_tracks(frames)
    distinct = len(tracks)
    live_frames = sum(1 for fr in frames for ac in fr["aircraft"] if is_live(ac))
    listed_frames = sum(len(fr["aircraft"]) for fr in frames)

    numeric_keys = [
        "rssi", "msg_rate", "seen", "seen_pos", "r_dst", "r_dir", "alt_baro", "alt_geom", "geom_minus_baro",
        "baro_rate", "geom_rate", "gs", "track", "nav_altitude_mcp", "nav_heading", "nav_qnh",
        "ias", "mach", "mag_heading", "tas", "roll", "track_rate",
    ]
    fields = {k: measure_numeric(k, tracks, live_frames, distinct, listed_frames) for k in numeric_keys}

    # alt_baro is a number or the string "ground"; the number stats above skip the string.
    ground = airborne = 0
    for obs in tracks.values():
        for _t, _fi, ac in obs:
            if is_live(ac) and "alt_baro" in ac:
                if ac["alt_baro"] == "ground":
                    ground += 1
                else:
                    airborne += 1
    fields["alt_baro"]["ground_share"] = ground / (ground + airborne) if ground + airborne else 0.0

    for k in CODE_FIELDS:
        fields[k] = measure_categorical(k, tracks, distinct, live_frames)
    codes = collections.Counter()
    for obs in tracks.values():
        for _t, _fi, ac in obs:
            if is_live(ac) and all(k in ac for k in CODE_FIELDS):
                codes[tuple(ac[k] for k in CODE_FIELDS)] += 1
    fields["_code_bundle"] = {"distinct": len(codes), "entropy_bits": entropy_bits(codes), "n": sum(codes.values())}

    for k in ("type", "category", "sil_type", "emergency", "squawk", "t", "desc", "ownOp", "dbFlags"):
        fields[k] = measure_categorical(k, tracks, distinct, live_frames)
    fields["nav_modes"] = measure_nav_modes(tracks, live_frames)
    for k in ("alert", "spi"):
        fields[k] = measure_flag(k, tracks, live_frames)
    sq = collections.Counter()
    for obs in tracks.values():
        for _t, _fi, ac in obs:
            if is_live(ac) and "squawk" in ac:
                sq[ac["squawk"]] += 1
    tot = sum(sq.values())
    # Individual codes are transient identifiers of specific flights; only the VFR code is kept.
    fields["squawk"]["top"] = [t for t in fields["squawk"]["top"] if t[0] == "1200"]
    fields["squawk"]["vfr_1200_share_frames"] = sq.get("1200", 0) / tot if tot else 0.0
    fields["squawk"]["emergency_codes_frames"] = sum(sq.get(c, 0) for c in ("7500", "7600", "7700"))

    out = {
        "meta": {
            "kind": "pitchaxis-census",
            "v": 1,
            "receiver_software": (header or {}).get("receiver", {}).get("version"),
            "distinct_aircraft": distinct,
            "aircraft_frames_listed": listed_frames,
            "aircraft_frames_heard": live_frames,
            "heard_share": live_frames / listed_frames,
            "live_rule": f"seen < {LIVE_SEEN_SEC:g} s",
        },
        "sky": measure_sky(frames),
        "traffic": measure_traffic_events(tracks, frames),
        "identity": measure_identity(tracks, distinct),
        "fields": fields,
        "assoc": measure_assoc(tracks),
    }
    with open(args.out, "w") as fh:
        json.dump(out, fh, indent=1)
    print(f"wrote {args.out}: {distinct} aircraft, {live_frames} heard aircraft-frames", file=sys.stderr)


# ---------------------------------------------------------------- controls


def selftest(_args):
    """Each estimator against data whose answer is known. A control that cannot fail is
    not a control, so each block also asserts the NEGATIVE (independent data reads low)."""
    rng = np.random.default_rng(7)
    n = 300

    x = rng.normal(size=n)
    assert assoc_lin_lin(x, x**3) > 0.99, "monotone map must read ~1 under rank correlation"
    assert assoc_lin_lin(x, rng.normal(size=n)) < 0.2, "independent must read low"

    th = rng.uniform(0, 360, n)
    y_dep = 3 * np.cos(np.deg2rad(th - 40)) + 0.3 * rng.normal(size=n)
    assert assoc_circ_lin(th, y_dep) > 0.9, "angle-linear dependence missed"
    assert assoc_circ_lin(th, rng.normal(size=n)) < 0.2, "angle-linear false positive"
    ph = (th + 57 + 8 * rng.normal(size=n)) % 360
    assert assoc_circ_circ(th, ph) > 0.9, "angle-angle dependence missed"
    assert assoc_circ_circ(th, rng.uniform(0, 360, n)) < 0.2, "angle-angle false positive"

    # 12 columns from 4 latent sources, 3 noisy copies each: expect exactly 4 groups.
    latent = rng.normal(size=(n, 4))
    cols = [latent[:, i // 3] + 0.25 * rng.normal(size=n) for i in range(12)]
    m = [[1.0 if i == j else assoc_lin_lin(cols[i], cols[j]) for j in range(12)] for i in range(12)]
    g = cluster_average(m, CLUSTER_ASSOC)
    assert len(g) == 4, f"expected 4 groups from 4 sources, got {len(g)}"
    indep = [rng.normal(size=n) for _ in range(12)]
    m2 = [[1.0 if i == j else assoc_lin_lin(indep[i], indep[j]) for j in range(12)] for i in range(12)]
    assert len(cluster_average(m2, CLUSTER_ASSOC)) == 12, "independent columns must stay separate"

    # Dwell: constant 60 s then a jump then constant 30 s (frames every 5 s).
    s = [(5.0 * i, 0.0) for i in range(12)] + [(5.0 * i, 100.0) for i in range(12, 18)]
    d = dwell_seconds(s, tol=1.0, circular=False)
    assert sorted(d) == [30.0, 60.0], d
    assert weighted_median(d, d) == 60.0
    # Slow drift of 1 per frame with tol 2.5 must break every 3 frames, not run forever.
    drift = [(5.0 * i, float(i)) for i in range(30)]
    dd = dwell_seconds(drift, tol=2.5, circular=False)
    assert max(dd) <= 20.0 and len(dd) >= 8, dd
    # A missing frame ends the stretch even when the value is unchanged.
    gap = [(0.0, 1.0), (5.0, 1.0), (30.0, 1.0)]
    assert len(dwell_seconds(gap, 1.0, False)) == 2
    # Wrap: 359 -> 1 is a 2 degree move, not 358.
    assert len(dwell_seconds([(0.0, 359.0), (5.0, 1.0)], 3.0, True)) == 1

    assert grid_step([25 * k for k in range(1, 200)] + [26]) == 25, "one odd value in 200 must not break the grid"
    # The real failure: many readings on a 64 grid, plus a handful of aircraft each adding
    # unique finer values. Counting distinct values would call this 32.
    heavy = [64 * k for k in range(-20, 40)] * 40
    rare = [64 * k + 32 for k in range(-6, 6)]
    assert grid_step(heavy + rare) == 64, "rare finer values must not outvote the dominant grid"
    assert grid_step([32 * k for k in range(-20, 40)] * 40) == 32
    assert grid_step([64 * k for k in range(-20, 40)]) == 64
    assert grid_step(np.arange(0, 500)) is None

    assert weighted_median([1, 100], [1, 99]) == 100.0
    print("selftest ok")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    rec = sub.add_parser("record")
    rec.add_argument("--url", default=DEFAULT_URL)
    rec.add_argument("--seconds", type=float, default=1800.0)
    rec.add_argument("--out", required=True)
    mea = sub.add_parser("measure")
    mea.add_argument("--input", required=True)
    mea.add_argument("--out", required=True)
    sub.add_parser("selftest")
    args = ap.parse_args()
    {"record": record, "measure": measure, "selftest": selftest}[args.cmd](args)


if __name__ == "__main__":
    main()
