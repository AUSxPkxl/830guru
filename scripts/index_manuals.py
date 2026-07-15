import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import pdfplumber


ROOT = Path(__file__).resolve().parents[1]
MANUALS_DIR = ROOT / "data" / "manuals"
INDEX_PATH = ROOT / "data" / "index.json"
MANIFEST_PATH = ROOT / "data" / "index-manifest.json"


MANUAL_INFO = {
    "ShopManual.pdf": {
        "manualType": "shop_manual",
        "displayName": "830E-1AC Shop Manual",
        "truckVariant": "830E-1AC",
    },
    "OperationMaintanence.pdf": {
        "manualType": "operation_maintenance",
        "displayName": "830E-1AC Operation & Maintenance Manual",
        "truckVariant": "830E-1AC",
    },
    "PartsBook.pdf": {
        "manualType": "parts_book",
        "displayName": "830E-1AC Parts Book",
        "truckVariant": "830E-1AC",
    },
    "QSK60PartsBook.pdf": {
        "manualType": "engine_parts_book",
        "displayName": "Cummins QSK60 Parts Book",
        "truckVariant": "830E-1AC engine context",
    },
}


def main():
    manuals = sorted(MANUALS_DIR.glob("*.pdf"))
    if not manuals:
        print("No PDFs found in data/manuals", file=sys.stderr)
        return 1

    records = []
    manifest = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "manuals": [],
        "recordCount": 0,
    }

    for pdf_path in manuals:
        info = MANUAL_INFO.get(pdf_path.name, {
            "manualType": "manual",
            "displayName": pdf_path.stem,
            "truckVariant": "830E-1AC",
        })
        print(f"Indexing {pdf_path.name}...")
        manual_record = {
            "file": pdf_path.name,
            "displayName": info["displayName"],
            "manualType": info["manualType"],
            "pages": 0,
            "textPages": 0,
            "size": pdf_path.stat().st_size,
        }

        with pdfplumber.open(str(pdf_path)) as pdf:
            manual_record["pages"] = len(pdf.pages)
            for page_index, page in enumerate(pdf.pages, start=1):
                try:
                    text = extract_page_text(page)
                except Exception as exc:
                    text = f"[Text extraction failed on this page: {exc}]"
                text = clean_text(text)
                if text:
                    manual_record["textPages"] += 1
                records.append(build_record(pdf_path.name, info, page_index, text))

        manifest["manuals"].append(manual_record)

    manifest["recordCount"] = len(records)
    INDEX_PATH.write_text(json.dumps(records, indent=2), encoding="utf-8")
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Wrote {len(records)} page records to {INDEX_PATH}")
    return 0


def build_record(file_name, info, page_number, text):
    page_title = make_title(text, file_name, page_number)
    record_id = f"{slugify(Path(file_name).stem)}-p{page_number:04d}"
    systems = infer_systems(text, file_name)
    record_type = infer_type(text, file_name)
    quote = text[:700]
    return {
        "id": record_id,
        "title": page_title,
        "truckVariant": info["truckVariant"],
        "manualFile": file_name,
        "manualType": info["manualType"],
        "system": ", ".join(systems),
        "type": record_type,
        "summary": summarize(text, page_title),
        "text": text,
        "source": {
            "manual": info["displayName"],
            "file": file_name,
            "page": page_number,
            "pageImage": f"/api/page-image?manual={file_name}&page={page_number}",
            "quote": quote,
        },
        "keywords": sorted(set(systems + keyword_hints(text, file_name))),
    }


def clean_text(text):
    text = text.replace("\x00", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_page_text(page):
    words = page.extract_words(x_tolerance=1.5, y_tolerance=3, use_text_flow=False, keep_blank_chars=False)
    if not words:
        return page.extract_text(x_tolerance=1.5, y_tolerance=3) or ""

    width = float(page.width)
    middle = width / 2
    left_words = [word for word in words if word["x0"] < middle - 8]
    right_words = [word for word in words if word["x0"] >= middle - 8]
    has_two_columns = len(left_words) > 25 and len(right_words) > 25

    if not has_two_columns:
      return words_to_lines(words)

    full_width = [word for word in words if word["x0"] < middle - 70 and word["x1"] > middle + 70]
    full_width_ids = {id(word) for word in full_width}
    left = [word for word in left_words if id(word) not in full_width_ids]
    right = [word for word in right_words if id(word) not in full_width_ids]

    sections = []
    header_words = [word for word in full_width if word["top"] < page.height * 0.22]
    footer_words = [word for word in full_width if word["top"] > page.height * 0.88]
    if header_words:
        sections.append(words_to_lines(header_words))
    if left:
        sections.append(words_to_lines(left))
    if right:
        sections.append(words_to_lines(right))
    if footer_words:
        sections.append(words_to_lines(footer_words))
    return "\n".join(section for section in sections if section.strip())


def words_to_lines(words):
    if not words:
        return ""
    sorted_words = sorted(words, key=lambda word: (round(float(word["top"]) / 3) * 3, float(word["x0"])))
    lines = []
    current_top = None
    current = []
    for word in sorted_words:
        top = float(word["top"])
        if current_top is None or abs(top - current_top) <= 3:
            current.append(word)
            if current_top is None:
                current_top = top
        else:
            lines.append(" ".join(item["text"] for item in sorted(current, key=lambda item: item["x0"])))
            current = [word]
            current_top = top
    if current:
        lines.append(" ".join(item["text"] for item in sorted(current, key=lambda item: item["x0"])))
    return "\n".join(lines)


def make_title(text, file_name, page_number):
    for line in text.splitlines():
        line = line.strip(" -\t")
        if 8 <= len(line) <= 90 and not re.fullmatch(r"[\d\s./-]+", line):
            return line
    return f"{Path(file_name).stem} page {page_number}"


def summarize(text, fallback):
    if not text:
        return "No extractable text found on this page. Use the page image/PDF for visual review."
    compact = re.sub(r"\s+", " ", text)
    return compact[:420]


def infer_systems(text, file_name):
    source = f"{file_name} {text}".lower()
    systems = []
    checks = [
        ("fault codes", ["fault code", "event code", "diagnostic", "troubleshooting"]),
        ("torque specs", ["torque", "tighten", "tightening"]),
        ("pressures", ["pressure", "psi", "kpa", "mpa", "test port"]),
        ("procedures", ["procedure", "removal", "installation", "adjustment", "inspection"]),
        ("electrical", ["electrical", "alternator", "drive system", "grid", "inverter", "control cabinet"]),
        ("hydraulics", ["hydraulic", "hoist", "steering", "brake cooling"]),
        ("brakes", ["brake", "retarder"]),
        ("engine", ["qsk60", "cummins", "engine", "fuel pump", "injector"]),
        ("parts", ["part no", "part number", "item", "qty", "parts book"]),
    ]
    for label, needles in checks:
        if any(needle in source for needle in needles):
            systems.append(label)
    if not systems:
        systems.append("general")
    return systems


def infer_type(text, file_name):
    source = f"{file_name} {text}".lower()
    if "partsbook" in file_name.lower() or "part no" in source or "part number" in source:
        return "parts"
    if "fault code" in source or "event code" in source or "diagnostic" in source:
        return "fault_code"
    if "torque" in source:
        return "torque"
    if "pressure" in source or " psi" in source or " kpa" in source or " mpa" in source:
        return "pressure"
    if "procedure" in source or "removal" in source or "installation" in source:
        return "procedure"
    return "manual_page"


def keyword_hints(text, file_name):
    words = re.findall(r"[A-Za-z][A-Za-z0-9-]{2,}", f"{file_name} {text.lower()}")
    stop = {
        "the", "and", "for", "with", "from", "this", "that", "are", "page",
        "manual", "komatsu", "section", "figure", "table", "part", "parts",
    }
    scored = {}
    for word in words:
        lower = word.lower()
        if lower in stop or len(lower) > 28:
            continue
        scored[lower] = scored.get(lower, 0) + 1
    return [word for word, _ in sorted(scored.items(), key=lambda item: item[1], reverse=True)[:30]]


def slugify(value):
    value = re.sub(r"[^a-zA-Z0-9]+", "-", value.lower()).strip("-")
    return value or "manual"


if __name__ == "__main__":
    raise SystemExit(main())
