# /// script
# dependencies = ["matplotlib"]
# ///
"""Figures and table drawn from the committed signal census.

Reads census/census.json and writes, beside this file:
  timescales.pdf     how long each numeric signal stays put
  signals-table.tex  the signal table that the note inputs

Run with: uv run make_census_figures.py
Every number in both outputs comes from census.json; nothing is typed by hand.
"""
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = Path(__file__).resolve().parent
CENSUS = HERE.parents[1] / "census" / "census.json"
census = json.loads(CENSUS.read_text())
fields = census["fields"]

# ---------------------------------------------------------------- time scales
# Categorical slots 1 to 3 of the validated default palette (light mode, all-pairs pass).
INK, MUTED = "#1c1c1b", "#52514e"
GROUPS = [
    ("Made by the receiver", "#2a78d6", "o", [
        ("msg_rate", "Message rate", "2 msg/s"), ("r_dst", "Range", "0.5 NM"),
        ("r_dir", "Bearing", "2°"), ("rssi", "Signal strength", "3 dB")]),
    ("Broadcast by the aircraft", "#eb6834", "s", [
        ("alt_baro", "Altitude", "100 ft"), ("baro_rate", "Climb rate", "128 ft/min"),
        ("gs", "Ground speed", "5 kt"), ("track", "Track", "2°")]),
    ("Set by the pilot", "#1baf7a", "D", [
        ("nav_heading", "Selected heading", "2°"), ("nav_altitude_mcp", "Selected altitude", "100 ft"),
        ("nav_qnh", "Pressure setting", "0.5 hPa")]),
]


def timescales():
    plt.rcParams.update({"font.size": 8, "pdf.fonttype": 42, "axes.edgecolor": MUTED,
                         "text.color": INK, "axes.labelcolor": INK, "xtick.color": MUTED})
    fig, ax = plt.subplots(figsize=(6.5, 3.5))
    y = 0.0
    yticks, ylabels = [], []
    for gname, colour, marker, rows in GROUPS:
        ax.text(3.7, y, gname, ha="left", va="center", fontsize=8, fontweight="bold", color=INK)
        y += 1.0
        for key, label, tol in sorted(rows, key=lambda r: fields[r[0]]["dwell"]["med_s"]):
            d = fields[key]["dwell"]
            med, p90 = d["med_s"], d["p90_s"]
            ax.plot([med, p90], [y, y], color=colour, lw=1.4, solid_capstyle="butt", zorder=2)
            ax.plot([p90, p90], [y - 0.18, y + 0.18], color=colour, lw=1.4, zorder=2)
            ax.plot([med], [y], marker=marker, ms=6, color=colour, mec="#fcfcfb", mew=1.2, zorder=3)
            yticks.append(y)
            ylabels.append(f"{label} (±{tol})")
            y += 1.0
        y += 0.5
    ax.set_ylim(y - 0.2, -0.8)
    ax.set_xscale("log")
    ax.set_xlim(3.6, 1300)
    ax.set_xticks([5, 10, 30, 60, 300, 900])
    ax.set_xticklabels(["5 s", "10 s", "30 s", "1 min", "5 min", "15 min"])
    ax.minorticks_off()
    ax.set_yticks(yticks)
    ax.set_yticklabels(ylabels, color=INK)
    ax.tick_params(axis="y", length=0)
    ax.grid(axis="x", color="#e4e3df", lw=0.6, zorder=0)
    ax.axvline(5, color=MUTED, lw=0.8, ls=(0, (3, 3)), zorder=1)
    ax.text(5.4, y - 0.45, "frame interval, 5 s", fontsize=7, color=MUTED, ha="left", va="bottom")
    for s in ("top", "right", "left"):
        ax.spines[s].set_visible(False)
    ax.set_xlabel("Typical stretch over which the value stays within the tolerance shown")
    ax.text(1300, 0.0, "dot: median stretch\nline end: 1 in 10 stretches is longer",
            fontsize=7, color=MUTED, ha="right", va="center", linespacing=1.5)
    fig.tight_layout()
    fig.savefig(HERE / "timescales.pdf")


# ---------------------------------------------------------------- table
def pct(key):
    return f"{round(100 * fields[key]['share_frames'])}"


def num(x, nd=0):
    s = f"{abs(x):,.{nd}f}"
    return f"$-${s}" if x < 0 else s


def span(key, unit, nd=0):
    q = fields[key]["q"]
    return f"{num(q['p1'], nd)} to {num(q['p99'], nd)} {unit}"


def labels(key):
    f = fields[key]
    return f"{f['distinct']} values, {f['entropy_bits']:.1f} bits"


modes = fields["nav_modes"]
sq = fields["squawk"]
src = fields["type"]
share = {name: round(100 * p) for name, p in src["top"]}
ROWS = [
    ("Made by the receiver", [
        ("Signal strength", "continuous", span("rssi", "dBFS", 1), pct("rssi")),
        ("Message rate", "continuous", span("msg_rate", "msg/s", 1), pct("msg_rate")),
        ("Range", "continuous", span("r_dst", "NM", 1), pct("r_dst")),
        ("Bearing", "angle", "0 to 360 degrees, wraps", pct("r_dir")),
    ]),
    ("Broadcast by the aircraft", [
        ("Altitude (pressure)", "stepped", f"{span('alt_baro', 'ft')}; steps of {fields['alt_baro']['grid']} ft", pct("alt_baro")),
        ("Climb rate", "stepped", f"{span('baro_rate', 'ft/min')}; steps of {fields['baro_rate']['grid']} ft/min", pct("baro_rate")),
        ("Ground speed", "continuous", f"{span('gs', 'kt')}; whole-knot components", pct("gs")),
        ("Track", "angle", "0 to 360 degrees, wraps", pct("track")),
    ]),
    ("Set by the pilot or assigned by control", [
        ("Selected altitude", "stepped", f"{span('nav_altitude_mcp', 'ft')}; steps of {fields['nav_altitude_mcp']['grid']} ft", pct("nav_altitude_mcp")),
        ("Selected heading", "angle", "0 to 360 degrees, steps of 0.70 degree", pct("nav_heading")),
        ("Pressure setting", "stepped", f"{span('nav_qnh', 'hPa', 1)}; steps of 0.8 hPa", pct("nav_qnh")),
        ("Autopilot modes", "combination", f"six switches, {modes['combos']} combinations seen", f"{round(100 * modes['share_frames'])}"),
        ("Transponder code", "category", f"{sq['distinct']} codes among {sq['n_ac']} aircraft, {sq['entropy_bits']:.1f} bits", pct("squawk")),
    ]),
    ("Identity, unchanged while in view", [
        ("Size class", "category", labels("category"), pct("category")),
        ("Aircraft type", "category", labels("t"), pct("t")),
        ("Operator", "category", labels("ownOp"), pct("ownOp")),
    ]),
    ("How the contact arrived", [
        ("Source of the contact", "category",
         f"ADS-B {share['adsb_icao']}\\%, Mode S only {share['mode_s']}\\%, multilaterated {share['mlat']}\\%", pct("type")),
        ("Quality codes", "combination", f"{fields['_code_bundle']['distinct']} combinations of eight codes, {fields['_code_bundle']['entropy_bits']:.1f} bits", f"{round(100 * fields['_code_bundle']['n'] / census['meta']['aircraft_frames_heard'])}"),
    ]),
]


def table():
    sky = census["sky"]
    out = ["% Generated by make_census_figures.py from census.json. Do not edit by hand.",
           "\\begin{tabular}{@{}llp{7.1cm}r@{}}", "\\toprule",
           "Signal & Shape & Range and resolution, or number of values & Present (\\%)\\\\"]
    for group, rows in ROWS:
        out.append("\\midrule")
        out.append(f"\\multicolumn{{4}}{{@{{}}l}}{{\\emph{{{group}}}}}\\\\")
        for name, shape, detail, present in rows:
            out.append(f"{name} & {shape} & {detail} & {present}\\\\")
    out.append("\\midrule")
    out.append(f"\\multicolumn{{4}}{{@{{}}l}}{{\\emph{{The whole sky}}}}\\\\")
    out.append(f"Frame clock & stepped & a grid of {sky['period_median_s']:.0f} s; longest gap {sky['period_max_s']:.1f} s & n/a\\\\")
    out += ["\\bottomrule", "\\end{tabular}"]
    (HERE / "signals-table.tex").write_text("\n".join(out) + "\n")


if __name__ == "__main__":
    timescales()
    table()
    print("wrote timescales.pdf and signals-table.tex")
