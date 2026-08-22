"""
Ensure the project's venv site-packages take priority over any user/system
site-packages. This is needed when the system has an older SQLAlchemy
installed in ~/.local that lacks aiosqlite support.
"""
import sys
from pathlib import Path

# Insert venv site-packages at the front so they win over ~/.local
_venv = Path(__file__).parent / ".venv" / "lib"
for _sp in sorted(_venv.glob("python*/site-packages")):
    if str(_sp) not in sys.path:
        sys.path.insert(0, str(_sp))
