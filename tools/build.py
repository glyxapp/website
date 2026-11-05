"""Builds catalog/: packs every folder in sources/ into catalog/sources/<id>.zip, checks the
templates and widgets, and writes catalog/catalog.json for the gallery pages, signed into
catalog/catalog.json.sig with the Glyx release key (the one Glyx updates are signed with, whose
public key the app has): Glyx checks a widget source it installs against the signed catalog.

    python tools/build.py          # build, and sign catalog.json when it changed
    python tools/build.py --check  # fail if catalog/ is out of date or not signed (CI)

Signing runs `tauri signer sign` (Node, npx) with the key in TAURI_SIGNING_PRIVATE_KEY (or its
file in TAURI_SIGNING_PRIVATE_KEY_PATH) and its password in TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
"""

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "catalog"
SITE = "https://glyx.org"
REPO = "https://github.com/glyxapp/website/tree/main"
# The Tauri CLI that signs, the version the Glyx repo uses.
TAURI_CLI = "@tauri-apps/cli@2.12.4"

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


def preview(name: str) -> dict:
    """`catalog/previews/<name>.jpg`, captured by tools/capture-previews.mjs, when there is one."""
    path = f"catalog/previews/{name}.jpg"
    return {"preview": f"{SITE}/{path}"} if (ROOT / path).is_file() else {}


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


def sign(path: Path):
    """Signs `path` into `<path>.sig` with the Glyx release key, or says why it cannot."""
    key_path = os.environ.get("TAURI_SIGNING_PRIVATE_KEY_PATH")
    if not os.environ.get("TAURI_SIGNING_PRIVATE_KEY") and not key_path:
        fail("catalog.json changed and is not signed: set TAURI_SIGNING_PRIVATE_KEY (or _PATH) and run again")
    npx = shutil.which("npx") or fail("signing needs Node (npx)")
    args = [npx, "--yes", TAURI_CLI, "signer", "sign"] + (["-f", key_path] if key_path else []) + [str(path)]
    subprocess.run(args, check=True, cwd=ROOT, stdout=subprocess.DEVNULL)
    print(f"catalog: signed {path.relative_to(ROOT).as_posix()}")


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
            # What Glyx compares the package it downloads with, and the gallery adds to its link.
            "sha256": hashlib.sha256(data).hexdigest(),
            "code": f"{REPO}/sources/{m['id']}",
            "link": f"glyx://install?url={SITE}/{path}", **preview(f"source-{m['id']}"),
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
            "link": f"glyx://import?url={SITE}/{path}", **preview(f"template-{meta['id']}"),
        })

    for meta in src["widgets"]:
        path = f"catalog/widgets/{meta['id']}.json"
        w = json.loads((ROOT / path).read_text(encoding="utf-8"))
        if w.get("plugin") not in names:
            fail(f"{path}: unknown widget source {w.get('plugin')}")
        out["widgets"].append({
            **meta, "file": f"/{path}", "plugin": w["plugin"], "pluginName": names[w["plugin"]],
            "builtin": w["plugin"] in BUILTIN, "link": f"glyx://add?url={SITE}/{path}", **preview(f"widget-{meta['id']}"),
        })

    files["catalog/catalog.json"] = (json.dumps(out, ensure_ascii=False, indent=2) + "\n").encode()
    stale = [p for p, data in files.items() if not (ROOT / p).is_file() or (ROOT / p).read_bytes() != data]
    signature = CATALOG / "catalog.json.sig"
    if check:
        if stale:
            fail("out of date, run python tools/build.py: " + ", ".join(stale))
        if not signature.is_file():
            fail("catalog.json is not signed: run python tools/build.py with the release key set")
        return
    # A catalog changed since it was signed no longer matches its signature: the old one goes
    # first, so a signing that fails leaves no signature rather than a wrong one.
    if "catalog/catalog.json" in stale:
        signature.unlink(missing_ok=True)
    for p in stale:
        (ROOT / p).parent.mkdir(parents=True, exist_ok=True)
        (ROOT / p).write_bytes(files[p])
    if not signature.is_file():
        sign(CATALOG / "catalog.json")
    print(f"catalog: {len(out['templates'])} templates, {len(out['widgets'])} widgets, {len(out['sources'])} sources; "
          f"{len(stale)} file(s) written")


if __name__ == "__main__":
    main()
