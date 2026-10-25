"""Pack a pitchaxis capture into a compact replay for the browser editor.

Drops lat/lon and the site coordinates (they locate the antenna); keeps only the
receiver-relative polar position. Position-derived fields only when seen_pos < 6 s
(census.py's POS_SEEN_SEC), so frozen silent aircraft do not read as holding still.
"""
import base64, gzip, json, sys
from pathlib import Path

P = Path(__file__).resolve().parent.parent
# types.json maps an ICAO type designator to [wake category, engine type, description code]. It is extracted from
# the tar1090 aircraft database, which carries no licence, so it is not in this repository.
if len(sys.argv) != 2:
    sys.exit('usage: python pack.py path/to/types.json')
TYPES = json.loads(Path(sys.argv[1]).read_text())

def pack(path, label):
    lines = gzip.open(path, 'rt').read().splitlines()
    head = json.loads(lines[0])
    frames = [json.loads(l) for l in lines[1:]]
    t0 = frames[0]['now']
    ids, acs, out_frames, times = {}, [], [], []
    last_msg = {}
    for f in frames:
        t = f['now'] - t0
        row = []
        for a in f['aircraft']:
            if a.get('seen_pos', 99) >= 6.0 or 'r_dst' not in a:
                continue
            alt = a.get('alt_baro')
            if alt == 'ground':
                alt = 0
            if alt is None:
                continue
            h = a['hex']
            if h not in ids:
                ty = a.get('t', '')
                wake, eng, _ = TYPES.get(ty, ['?', '?', '?'])
                ids[h] = len(acs)
                acs.append([(a.get('flight') or '').strip(), ty, eng[0] if eng != '?' else '?', wake])
            i = ids[h]
            m = a.get('messages')
            rate = None
            if m is not None and h in last_msg:
                pm, pt = last_msg[h]
                if t > pt and m >= pm:
                    rate = round((m - pm) / (t - pt) * 10)
            if m is not None:
                last_msg[h] = (m, t)
            vr = a.get('baro_rate', a.get('geom_rate'))
            gs, trk = a.get('gs'), a.get('track')
            row += [i, int(round(alt / 25.0)),
                    None if vr is None else int(round(vr / 32.0)),
                    None if gs is None else int(round(gs)),
                    None if trk is None else int(round(trk * 10)),
                    int(round(a['r_dst'] * 10)), int(round(a['r_dir'] * 10)),
                    None if a.get('rssi') is None else int(round(a['rssi'] * 10)),
                    rate]
        times.append(round(t, 1))
        out_frames.append(row)
    cap = head.get('capture', {})
    meta = {'t0': frames[0]['now'], 'label': label, 'site': head['site'].get('label'), 
            'tz': cap.get('tz_abbrev'), 'utc_offset_sec': cap.get('utc_offset_sec'),
            'why': (head.get('slice') or {}).get('why', '')}
    blob = json.dumps({'meta': meta, 'ac': acs, 't': times, 'f': out_frames}, separators=(',', ':'))
    gz = gzip.compress(blob.encode(), 9, mtime=0)
    n_rows = sum(len(r) // 9 for r in out_frames)
    print(f'{label}: {len(times)} frames, {len(acs)} aircraft, {n_rows} plots, json {len(blob)/1e6:.2f} MB, gz {len(gz)/1e3:.0f} kB', file=sys.stderr)
    return base64.b64encode(gz).decode()

caps = {
    'push': pack(P / 'captures/kewr_20260909T1745Z_push.jsonl.gz', 'Newark rush, 17:45Z'),
    'quiet': pack(P / 'captures/kewr_20260909T1513Z_30min.jsonl.gz', 'Newark afternoon, 15:13Z'),
}
Path('data.js').write_text('const CAPTURES_B64 = ' + json.dumps(caps) + ';\n')
print(f"data.js {Path('data.js').stat().st_size/1e3:.0f} kB", file=sys.stderr)
