#!/usr/bin/env python3
"""deck-notes: write a .pptx's speaker notes as a JSON array, one string per slide in slide order.

Use: python3 -I tools/deck-notes.py DECK.pptx OUT.json
A slide with no notes gives "". Paragraphs are joined by a newline; a line break inside one is a newline too.
Only the notes body placeholder counts (not the slide image, slide number or header). test/unit/deck-notes.test.ts
runs it on a fixture and holds the committed demo-notes.json to the committed deck.
"""
import json
import posixpath
import sys
import zipfile
from xml.etree import ElementTree as ET  # the input is the repo's own deck, not an upload

A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG = "{http://schemas.openxmlformats.org/package/2006/relationships}"
NOTES_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"


def rels(z, part):
    """The relationships of a part: id -> (type, absolute target path)."""
    folder, name = posixpath.split(part)
    path = posixpath.join(folder, "_rels", name + ".rels")
    if path not in z.namelist():
        return {}
    out = {}
    for rel in ET.fromstring(z.read(path)).iter(PKG + "Relationship"):
        out[rel.get("Id")] = (rel.get("Type"), posixpath.normpath(posixpath.join(folder, rel.get("Target"))))
    return out


def paragraphs(shape):
    for para in shape.iter(A + "p"):
        text = ""
        for node in para.iter():
            if node.tag == A + "t":
                text += node.text or ""
            elif node.tag == A + "br":
                text += "\n"
        yield text


def body_text(notes_xml):
    for shape in ET.fromstring(notes_xml).iter(P + "sp"):
        ph = shape.find(f"{P}nvSpPr/{P}nvPr/{P}ph")
        if ph is not None and ph.get("type") == "body":
            return "\n".join(paragraphs(shape)).strip()
    return ""


def notes_of(src):
    with zipfile.ZipFile(src) as z:
        main = next((t for ty, t in _root(z) if ty.endswith("/officeDocument")), None)
        if main is None:
            sys.exit("no presentation part")
        pres_rels = rels(z, main)
        order = [e.get(R + "id") for e in ET.fromstring(z.read(main)).iter(P + "sldId")]
        notes = []
        for rid in order:
            slide = pres_rels[rid][1]
            target = next((t for ty, t in rels(z, slide).values() if ty == NOTES_REL), None)
            notes.append(body_text(z.read(target)) if target else "")
        return notes


def _root(z):
    for rel in ET.fromstring(z.read("_rels/.rels")).iter(PKG + "Relationship"):
        yield rel.get("Type"), posixpath.normpath(rel.get("Target"))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: python3 -I tools/deck-notes.py DECK.pptx OUT.json")
    with open(sys.argv[2], "w") as f:
        json.dump(notes_of(sys.argv[1]), f, ensure_ascii=False, indent=2)
        f.write("\n")
