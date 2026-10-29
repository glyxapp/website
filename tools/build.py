"""Builds catalog/: packs every folder in sources/ into catalog/sources/<id>.zip, checks the
templates and widgets, and writes catalog/catalog.json for the gallery pages.

    python tools/build.py          # build
    python tools/build.py --check  # fail if catalog/ is out of date (CI)
"""

import io
import json
import sys
import zipfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "catalog"
SITE = "https://glyx.org"
REPO = "https://github.com/glyxapp/website/tree/main"

# Widgets that ship with Glyx, so the gallery can name them.
BUILTIN = {
    "glyx.ai-usage": "AI usage", "glyx.bookmarks": "Bookmarks", "glyx.calendar": "Calendar",
    "glyx.clock": "Clock", "glyx.hackernews": "Hacker News", "glyx.markets": "Markets",
    "glyx.monitor": "Monitor", "glyx.releases": "Releases", "glyx.rss": "RSS",
    "glyx.system": "System", "glyx.todo": "To-do", "glyx.weather": "Weather",
}


def fail(msg):
    sys.exit(f"catalog: {msg}")


def pack(folder: Path) -> bytes:
    """A zip with fixed timestamps, so an unchanged source gives the same bytes."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(p for p in folder.rglob("*") if p.is_file()):
            info = zipfile.ZipInfo(f"{folder.name}/{f.relative_to(folder).as_posix()}", (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, f.read_bytes().replace(b"\r\n", b"\n"))
    return buf.getvalue()


def permissions(p: dict) -> list:
    """The same words Glyx shows in its install dialog (src-tauri/src/import.rs)."""
    out = []
    net = p.get("net", [])
    fixed = [h for h in net if not h.startswith("$config.")]
    if fixed:
        out.append("Connect to " + ", ".join(fixed))
    if len(fixed) < len(net):
        out.append("Connect to the addresses you enter in its settings")
    for key, text in [("net.lan", "Reach devices on your local network"), ("storage", "Keep its own data on this PC"),
                      ("system", "Read CPU, memory and disk usage"), ("notify", "Show notifications"),
                      ("label", "Show text in the tray icon and pills")]:
        if p.get(key):
            out.append(text)
    if p.get("ai.usage"):
        out.append("Read your usage of " + ", ".join(p["ai.usage"]))
    return out


def main():
    check = "--check" in sys.argv
    src = json.loads((ROOT / "tools/catalog.src.json").read_text(encoding="utf-8"))
    out = {"version": 1, "templates": [], "widgets": [], "sources": []}
    files = {}
    names = dict(BUILTIN)

    for meta in src["sources"]:
        folder = ROOT / "sources" / meta["id"]
        m = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        if m["id"] != meta["id"] or m["id"].startswith("glyx."):
            fail(f"sources/{meta['id']}: bad manifest id {m['id']}")
        if not (folder / m.get("entry", "index.html")).is_file():
            fail(f"sources/{meta['id']}: entry file missing")
        data = pack(folder)
        path = f"catalog/sources/{m['id']}.zip"
        files[path] = data
        names[m["id"]] = m["name"]
        out["sources"].append({
            **meta, "name": m["name"], "version": m["version"], "description": m.get("description", ""),
            "permissions": permissions(m.get("permissions", {})), "file": f"/{path}", "size": len(data),
            "code": f"{REPO}/sources/{m['id']}",
            "link": f"glyx://install?url={SITE}/{path}",
        })

    for meta in src["templates"]:
        path = f"catalog/templates/{meta['id']}.yml"
        cfg = yaml.safe_load((ROOT / path).read_text(encoding="utf-8"))
        widgets = [w for p in cfg.get("pages", []) for c in p.get("columns", []) for w in c.get("widgets", [])]
        unknown = sorted({w["plugin"] for w in widgets} - names.keys())
        if unknown:
            fail(f"{path}: unknown widgets {unknown}")
        out["templates"].append({
            **meta, "file": f"/{path}", "pages": [p["name"] for p in cfg["pages"]],
            "widgets": sorted({names[w["plugin"]] for w in widgets}), "count": len(widgets),
            "link": f"glyx://import?url={SITE}/{path}",
        })

    for meta in src["widgets"]:
        path = f"catalog/widgets/{meta['id']}.json"
        w = json.loads((ROOT / path).read_text(encoding="utf-8"))
        if w.get("plugin") not in names:
            fail(f"{path}: unknown widget source {w.get('plugin')}")
        out["widgets"].append({
            **meta, "file": f"/{path}", "plugin": w["plugin"], "pluginName": names[w["plugin"]],
            "builtin": w["plugin"] in BUILTIN, "link": f"glyx://add?url={SITE}/{path}",
        })

    files["catalog/catalog.json"] = (json.dumps(out, ensure_ascii=False, indent=2) + "\n").encode()
    stale = [p for p, data in files.items() if not (ROOT / p).is_file() or (ROOT / p).read_bytes() != data]
    if check:
        if stale:
            fail("out of date, run python tools/build.py: " + ", ".join(stale))
        return
    for p in stale:
        (ROOT / p).parent.mkdir(parents=True, exist_ok=True)
        (ROOT / p).write_bytes(files[p])
    print(f"catalog: {len(out['templates'])} templates, {len(out['widgets'])} widgets, {len(out['sources'])} sources; "
          f"{len(stale)} file(s) written")


if __name__ == "__main__":
    main()
