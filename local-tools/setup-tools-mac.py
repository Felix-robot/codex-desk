"""Independent Mac dependencies; run explicitly, never install into system Python."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

if sys.platform != "darwin":
    raise SystemExit("This installer runs on macOS only")
root = Path.home() / "Library/Application Support/Codex Desk/tools"
root.mkdir(parents=True, exist_ok=True, mode=0o700)
python = root / "python/bin/python3"
if not python.exists():
    subprocess.run([sys.executable, "-m", "venv", str(root / "python")], check=True)
subprocess.run([str(python), "-m", "pip", "install", "-r", str(Path(__file__).parent / "requirements-tools.txt")], check=True)
subprocess.run([str(python), "-m", "pip", "check"], check=True)
node_modules = root / "browser/node_modules/playwright"
npm = shutil.which("npm")
if npm and not node_modules.exists():
    # Uses installed Chrome/Edge; no Chromium download or browser profile copying.
    env = {**os.environ, "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1"}
    subprocess.run([npm, "install", "--prefix", str(root / "browser"), "--no-audit", "--no-fund", "playwright@1.58.2"], env=env, check=True)
subprocess.run([str(python), str(Path(__file__).parent / "tools/check-python.py"), str(root / "checks/python-tools")], check=True)
print(json.dumps({"status": "installed", "python": str(python), "browserDriver": node_modules.exists()}))
