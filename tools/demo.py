"""Create a deterministic synthetic volume and copy the viewer; no dependencies."""
import json
import math
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
out = root / 'demo'
out.mkdir(exist_ok=True)
n = 64
data = bytearray()
for z in range(n):
    for y in range(n):
        for x in range(n):
            a, b, c = ((v - (n-1)/2) / n for v in (x,y,z))
            radius = math.sqrt(a*a + b*b + c*c)
            shell = math.exp(-((radius - .29) / .018)**2)
            nucleus = math.exp(-((a+.10)**2+(b-.07)**2+(c+.04)**2)/.003)
            data.append(round(255 * max(shell*.7, nucleus)))
(out / 'volume.raw').write_bytes(data)
(out / 'volume.json').write_text(json.dumps(dict(shape=[n]*3, spacing=[1,1,2], unit='µm', title='Synthetic shell · anisotropic demo', channel=1, frame=1, sourceRange=[0,255], encoding='uint8', order='x-fastest')))
for file in (root / 'src/main/resources/viewer').iterdir():
    if file.is_dir():
        shutil.copytree(file, out / file.name, dirs_exist_ok=True)
    else:
        shutil.copyfile(file, out / file.name)
print(out)
