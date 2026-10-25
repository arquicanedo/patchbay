from pathlib import Path
h = Path('app.html').read_text()
h = h.replace('/*DATA*/', Path('data.js').read_text()).replace('/*APP*/', Path('app.js').read_text())
head = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">'
h = head + h + '</body></html>'
Path('pitchaxis-patchbay.html').write_text(h)
print(f"{len(h)/1e6:.2f} MB")
