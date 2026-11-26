#!/usr/bin/env python3
"""slim-deck: shrink a .pptx for the demo and strip who made it, without changing a slide.

Use: python3 -I tools/slim-deck.py IN.pptx OUT.pptx [--quality N]   (jpegtran on PATH shrinks the JPEGs; --quality needs Pillow)
Drops slide layouts no slide uses and every part they alone reach (media, thumbnail, label info), blanks the
creator, last modifier, company and manager, runs jpegtran (lossless) on every JPEG and zips at deflate 9 with fixed
timestamps. Notes slides and the notes master stay. With --quality the kept JPEGs are re-encoded (lossy), only when smaller.
Then checks the package: every relationship target exists, every part has a content type, every XML part parses.
test/unit/slim-deck.test.ts runs it on a small fixture.
"""
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

CT = "{http://schemas.openxmlformats.org/package/2006/content-types}"
RL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
LAYOUT = "slideLayout"
SLIDE = "/relationships/slide"
IDENTITY = {
    "docProps/core.xml": ("dc:creator", "cp:lastModifiedBy", "dc:title"),
    "docProps/app.xml": ("Company", "Manager", "Template"),
}


def rels_path(part):
    d, name = posixpath.split(part)
    return posixpath.join(d, "_rels", name + ".rels")


def targets(parts, part):
    """The parts `part` points to by relationship, as (rel id, type, resolved path); external ones are skipped."""
    raw = parts.get(rels_path(part))
    if raw is None:
        return []
    out = []
    for r in ET.fromstring(raw).findall(RL + "Relationship"):
        if r.get("TargetMode") == "External":
            continue
        target = r.get("Target")
        path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(posixpath.dirname(part), target))
        out.append((r.get("Id"), r.get("Type"), path))
    return out


def reachable(parts):
    seen, todo = set(), ["[Content_Types].xml", "_rels/.rels", *(t for _, _, t in targets(parts, ""))]
    while todo:
        p = todo.pop()
        if p in seen or p not in parts:
            continue
        seen.add(p)
        if rels_path(p) in parts:
            todo.append(rels_path(p))
        for _, _, t in targets(parts, p):
            todo.append(t)
    return seen


def drop_relationships(parts, part, wanted):
    """Remove from `part`'s rels file every relationship whose resolved target `wanted` says to drop."""
    path = rels_path(part)
    text = parts[path].decode()
    for rid, _, target in targets(parts, part):
        if wanted(target):
            text = re.sub(r'<Relationship [^>]*Id="%s"[^>]*/>' % re.escape(rid), "", text)
    parts[path] = text.encode()


def prune_layouts(parts):
    used = {t for p in parts if re.fullmatch(r"ppt/slides/slide\d+\.xml", p) for _, ty, t in targets(parts, p) if ty.endswith("/slideLayout")}
    for master in [p for p in parts if re.fullmatch(r"ppt/slideMasters/slideMaster\d+\.xml", p)]:
        dead = {t for _, ty, t in targets(parts, master) if ty.endswith("/slideLayout") and t not in used}
        ids = {rid for rid, ty, t in targets(parts, master) if t in dead}
        xml = parts[master].decode()
        for rid in ids:
            xml = re.sub(r'<p:sldLayoutId [^>]*r:id="%s"[^>]*/>' % re.escape(rid), "", xml)
        parts[master] = xml.encode()
        drop_relationships(parts, master, lambda t: t in dead)


def scrub(parts):
    for part, tags in IDENTITY.items():
        if part in parts:
            text = parts[part].decode()
            for tag in tags:
                text = re.sub(r"<%s>[^<]*</%s>|<%s\s*/>" % (tag, tag, tag), "", text)
            text = re.sub(r"<dcterms:(created|modified)[^>]*>[^<]*</dcterms:\1>", "", text)
            parts[part] = text.encode()


def jpegtran(data):
    if not shutil.which("jpegtran"):
        return data
    with tempfile.NamedTemporaryFile(suffix=".jpg") as src, tempfile.NamedTemporaryFile(suffix=".jpg") as out:
        src.write(data)
        src.flush()
        subprocess.run(["jpegtran", "-optimize", "-progressive", "-copy", "none", "-outfile", out.name, src.name], check=True)
        return Path(out.name).read_bytes()


def reencode(data, quality):
    import io

    from PIL import Image

    img = Image.open(io.BytesIO(data))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality, optimize=True, progressive=True, subsampling="keep" if img.mode == "YCbCr" else -1)
    return buf.getvalue()


def validate(parts):
    ct = ET.fromstring(parts["[Content_Types].xml"])
    defaults = {d.get("Extension").lower() for d in ct.findall(CT + "Default")}
    overrides = {o.get("PartName").lstrip("/") for o in ct.findall(CT + "Override")}
    for o in overrides:
        assert o in parts, f"content type for a missing part: {o}"
    for p, data in parts.items():
        if p == "[Content_Types].xml":
            continue
        assert p in overrides or p.rsplit(".", 1)[-1].lower() in defaults, f"no content type: {p}"
        if p.endswith((".xml", ".rels")):
            ET.fromstring(data)
        for _, _, t in targets(parts, p) if not p.endswith(".rels") else []:
            assert t in parts, f"{p} points to a missing part: {t}"
    for p in parts:
        if p.endswith(".rels"):
            owner = posixpath.join(posixpath.dirname(posixpath.dirname(p)), posixpath.basename(p)[: -len(".rels")])
            assert p == "_rels/.rels" or owner in parts, f"rels without a part: {p}"
    assert any(re.fullmatch(r"ppt/slides/slide\d+\.xml", p) for p in parts), "no slides"


def slim(src, dst, quality=None):
    with zipfile.ZipFile(src) as z:
        parts = {n: z.read(n) for n in z.namelist() if not n.endswith("/")}
    prune_layouts(parts)
    # Nothing in the demo needs a preview picture or a sensitivity label.
    root_rels = parts["_rels/.rels"].decode()
    for rid, ty, t in targets(parts, ""):
        if ty.endswith("/thumbnail") or "docMetadata" in t:
            root_rels = re.sub(r'<Relationship [^>]*Id="%s"[^>]*/>' % re.escape(rid), "", root_rels)
    parts["_rels/.rels"] = root_rels.encode()
    keep = reachable(parts)
    parts = {p: d for p, d in parts.items() if p in keep}
    ct = parts["[Content_Types].xml"].decode()
    for o in re.findall(r'<Override [^>]*PartName="/([^"]+)"[^>]*/>', ct):
        if o not in parts:
            ct = re.sub(r'<Override [^>]*PartName="/%s"[^>]*/>' % re.escape(o), "", ct)
    parts["[Content_Types].xml"] = ct.encode()
    scrub(parts)
    for p, data in list(parts.items()):
        if p.lower().endswith((".jpg", ".jpeg")):
            slimmer = jpegtran(data)
            if quality:
                lossy = reencode(data, quality)
                if len(lossy) < len(slimmer):
                    slimmer = lossy
            parts[p] = min(data, slimmer, key=len)
    validate(parts)
    for _, _, t in targets(parts, ""):
        assert t in parts, f"the package root points to a missing part: {t}"
    order = ["[Content_Types].xml", "_rels/.rels"] + sorted(p for p in parts if p not in ("[Content_Types].xml", "_rels/.rels"))
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in order:
            info = zipfile.ZipInfo(p, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, parts[p], compresslevel=9)
    return len(Path(src).read_bytes()), len(Path(dst).read_bytes())


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    quality = next((int(a.split("=")[1]) for a in sys.argv[1:] if a.startswith("--quality=")), None)
    if len(args) != 2:
        sys.exit("usage: python3 -I tools/slim-deck.py IN.pptx OUT.pptx [--quality=N]")
    before, after = slim(args[0], args[1], quality)
    print(f"{before} -> {after} bytes")
