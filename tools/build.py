"""Build without Maven: python3 tools/build.py --jdk /path/to/jdk --imagej /path/to/ij.jar"""
import argparse
from pathlib import Path
import shutil
import subprocess
import zipfile
import os

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--jdk', type=Path, required=True)
parser.add_argument('--imagej', type=Path, required=True)
parser.add_argument('--zxing', type=Path, default=Path(__file__).resolve().parents[2]/'.build-tools/downloads/zxing-core-3.5.3.jar')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
jdk = args.jdk.resolve()
ij = args.imagej.resolve()
zxing = args.zxing.resolve()
compile_cp = os.pathsep.join([str(ij), str(zxing)])
classes = root / 'target/classes'
tests = root / 'target/test-classes'
for folder in (classes, tests):
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(parents=True)
subprocess.run([str(jdk/'bin/javac'), '--release', '8', '-cp', compile_cp, '-d', str(classes), *[str(p) for p in (root/'src/main/java').glob('*.java')]], check=True)
shutil.copytree(root/'src/main/resources', classes, dirs_exist_ok=True)
metadata = classes / 'META-INF'
metadata.mkdir(exist_ok=True)
shutil.copy2(root / 'LICENSE', metadata / 'LICENSE')
with zipfile.ZipFile(zxing) as dependency:
    for entry in dependency.infolist():
        if entry.filename.startswith('com/google/zxing/') and not entry.is_dir():
            destination = classes / entry.filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(dependency.read(entry))
subprocess.run([str(jdk/'bin/javac'), '--release', '8', '-cp', os.pathsep.join([str(ij), str(classes)]), '-d', str(tests), *[str(p) for p in (root/'src/test/java').glob('*.java')]], check=True)
subprocess.run([str(jdk/'bin/java'), '-Djava.awt.headless=true', '-cp', os.pathsep.join([str(ij), str(classes), str(tests)]), 'ExportSmokeTest'], check=True)
subprocess.run([str(jdk/'bin/java'), '-Djava.awt.headless=true', '-cp', os.pathsep.join([str(ij), str(classes), str(tests)]), 'SessionSmokeTest'], check=True)
subprocess.run([str(jdk/'bin/java'), '-Djava.awt.headless=true', '-cp', os.pathsep.join([str(ij), str(classes), str(tests)]), 'LocalTransferSmokeTest'], check=True)
artifact = root/'target/fiji-vr-0.12.0.jar'
subprocess.run([str(jdk/'bin/jar'), 'cf', str(artifact), '-C', str(classes), '.'], check=True)
print(f'Built: {artifact}')
