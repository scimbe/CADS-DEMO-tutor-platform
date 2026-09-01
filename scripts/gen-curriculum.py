import json, re, sys

import os
TP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def slug(docpath):
    s = re.sub(r'\.html$', '', docpath)
    s = re.sub(r'[^a-zA-Z0-9]+', '-', s).strip('-').lower()
    return s

def load(track):
    manifest = json.load(open(f"{TP}/content-packs/{track}/manifest.json"))
    index = json.load(open(f"{TP}/content-packs/{track}/index.json"))
    return manifest, index

def chunks_for(index, docBaseUrl, docPath, track):
    if track == "rust":
        # rust docPath entries are literal html filenames, urls in index.json point at
        # doc.rust-lang.org/book/<docPath>#anchor
        prefix_candidates = [docPath]
    else:
        prefix_candidates = [docBaseUrl.rstrip("/") + "/" + docPath.lstrip("/")]
    ids = []
    for c in index:
        url = c.get("url", "")
        for pc in prefix_candidates:
            if pc in url:
                ids.append(c["id"])
                break
    return ids

# ---------- firmware ----------
fw_manifest, fw_index = load("firmware")
docBaseUrl = fw_manifest["docBaseUrl"]
fw_chunks = {ch["docPath"]: chunks_for(fw_index, docBaseUrl, ch["docPath"], "firmware") for ch in fw_manifest["chapters"]}

def fwid(docPath):
    return "firmware-" + slug(docPath)

fw_defs = [
    ("HARDWARE/", "understand", "Student can identify the ITSboard's real hardware components (STM32F429ZI, NUCLEO-F429ZI, ITS adapter, Waveshare 4\" shield) and how they connect.", []),
    ("SAFETY/", "understand", "Student can state the board's non-negotiable safety rules (protected pins, flash region, no mass-erase) before touching real hardware.", ["HARDWARE/"]),
    ("how-to/vscode-setup/", "understand", "Student can get a working VS Code + toolchain setup for cads-zero from a clean checkout.", []),
    ("explanation/toolchain/", "understand", "Student can explain why this project uses this specific ARM toolchain and build setup.", ["how-to/vscode-setup/"]),
    ("how-to/build/", "apply", "Student can build cads-zero for both the board and host-sim targets.", ["how-to/vscode-setup/"]),
    ("reference/module-layout/", "understand", "Student can navigate the project's module layout after a successful build.", ["how-to/build/"]),
    ("reference/memory-map/", "understand", "Student can read the STM32F429ZI's memory map and locate flash/RAM/CCM regions relevant to this project.", ["how-to/build/"]),
    ("reference/hal/", "understand", "Student can look up and use cads-zero's HAL interface for a given peripheral.", ["how-to/build/"]),
    ("how-to/flash/", "apply", "Student can flash a built firmware image to the real board via st-flash, respecting the safety rules.", ["how-to/build/", "SAFETY/"]),
    ("how-to/board-test/", "apply", "Student can verify the board is running correctly after a flash using the serial console.", ["how-to/flash/"]),
    ("how-to/debug/", "apply", "Student can attach GDB/st-util to a running board and inspect live state.", ["how-to/flash/"]),
    ("tutorials/first-build/", "apply", "Student can independently complete a full build-flash-verify loop on real hardware from scratch.", ["how-to/build/", "how-to/flash/"]),
    ("tutorials/first-gate/", "apply", "Student can extend the first-build tutorial with a real conditional/gate in firmware logic.", ["tutorials/first-build/"]),
    ("tutorials/lwip-udp-hello/", "apply", "Student can send a real UDP packet from the board using cads_net_udp_send() and verify receipt on a host.", ["tutorials/first-gate/", "reference/hal/"]),
    ("explanation/clean-room/", "understand", "Student can explain this project's clean-room requirement and why it constrains how code may be written.", []),
]

fw_objs = []
for docPath, bloom, statement, prereq_paths in fw_defs:
    ids = fw_chunks.get(docPath, [])
    if not ids:
        print(f"WARNING firmware: no chunks matched for {docPath}", file=sys.stderr)
    fw_objs.append({
        "id": fwid(docPath),
        "track": "firmware",
        "unitId": fwid(docPath),
        "bloomLevel": bloom,
        "statement": statement,
        "sourceDocIds": ids,
        "prerequisiteObjectiveIds": [fwid(p) for p in prereq_paths],
    })

# ---------- rust ----------
rust_manifest, rust_index = load("rust")
rust_chunks = {ch["docPath"]: chunks_for(rust_index, "", ch["docPath"], "rust") for ch in rust_manifest["chapters"]}

def rid(docPath):
    return "rust-" + slug(docPath)

rust_defs = [
    ("ch04-01-what-is-ownership.html", "understand", "Student can explain what ownership is and why Rust uses it instead of a garbage collector.", []),
    ("ch04-02-references-and-borrowing.html", "apply", "Student can use references and borrowing to use a value without taking ownership of it.", ["ch04-01-what-is-ownership.html"]),
    ("ch04-03-slices.html", "apply", "Student can use slices to reference a contiguous sequence of elements without ownership.", ["ch04-02-references-and-borrowing.html"]),
    ("ch05-01-defining-structs.html", "apply", "Student can define and instantiate a struct to group related values.", ["ch04-03-slices.html"]),
    ("ch06-01-defining-an-enum.html", "understand", "Student can explain when an enum is the right tool versus a struct.", ["ch05-01-defining-structs.html"]),
    ("ch06-02-match.html", "apply", "Student can use match to handle every variant of an enum exhaustively.", ["ch06-01-defining-an-enum.html"]),
    ("ch06-03-if-let.html", "apply", "Student can use if let as concise sugar for a single-pattern match.", ["ch06-02-match.html"]),
    ("ch08-01-vectors.html", "apply", "Student can create, index, and iterate over a Vec<T>.", ["ch06-03-if-let.html"]),
    ("ch08-02-strings.html", "apply", "Student can explain why Rust strings are UTF-8 and work with String/&str correctly.", ["ch08-01-vectors.html"]),
    ("ch08-03-hash-maps.html", "apply", "Student can use a HashMap to associate keys with values.", ["ch08-02-strings.html"]),
    ("ch09-01-unrecoverable-errors-with-panic.html", "understand", "Student can explain when panic! is the right response to an error versus Result.", ["ch08-03-hash-maps.html"]),
    ("ch09-02-recoverable-errors-with-result.html", "apply", "Student can propagate and handle recoverable errors using Result and the ? operator.", ["ch09-01-unrecoverable-errors-with-panic.html"]),
    ("ch10-01-syntax.html", "understand", "Student can read and write generic type parameters in a function or struct signature.", ["ch09-02-recoverable-errors-with-result.html"]),
    ("ch10-02-traits.html", "apply", "Student can define a trait and use it as a bound to constrain generic code.", ["ch10-01-syntax.html"]),
    ("ch10-03-lifetime-syntax.html", "analyze", "Student can analyze why a borrow-checker error occurs and annotate lifetimes to resolve it.", ["ch10-02-traits.html"]),
]

rust_objs = []
for docPath, bloom, statement, prereq_paths in rust_defs:
    ids = rust_chunks.get(docPath, [])
    if not ids:
        print(f"WARNING rust: no chunks matched for {docPath}", file=sys.stderr)
    rust_objs.append({
        "id": rid(docPath),
        "track": "rust",
        "unitId": rid(docPath),
        "bloomLevel": bloom,
        "statement": statement,
        "sourceDocIds": ids,
        "prerequisiteObjectiveIds": [rid(p) for p in prereq_paths],
    })

# ---------- javascript ----------
js_manifest, js_index = load("javascript")
js_docBaseUrl = js_manifest.get("docBaseUrl", "https://developer.mozilla.org/en-US/docs/")
js_chunks = {ch["docPath"]: chunks_for(js_index, js_docBaseUrl, ch["docPath"], "javascript") for ch in js_manifest["chapters"]}

def jid(docPath):
    return "javascript-" + slug(docPath)

js_defs = [
    ("Web/JavaScript/Guide/Introduction", "understand", "Student can explain what JavaScript is and where it runs.", []),
    ("Web/JavaScript/Guide/Grammar_and_types", "understand", "Student can identify JavaScript's basic syntax, variable declarations, and primitive types.", ["Web/JavaScript/Guide/Introduction"]),
    ("Web/JavaScript/Guide/Control_flow_and_error_handling", "apply", "Student can use conditionals and try/catch to control program flow and handle errors.", ["Web/JavaScript/Guide/Grammar_and_types"]),
    ("Web/JavaScript/Guide/Loops_and_iteration", "apply", "Student can choose and write the right loop construct for a given iteration task.", ["Web/JavaScript/Guide/Control_flow_and_error_handling"]),
    ("Web/JavaScript/Guide/Functions", "apply", "Student can define and call functions, including closures and default parameters.", ["Web/JavaScript/Guide/Loops_and_iteration"]),
    ("Web/JavaScript/Guide/Working_with_objects", "analyze", "Student can analyze how object properties, prototypes, and methods relate to design a small object model.", ["Web/JavaScript/Guide/Functions"]),
    ("Web/JavaScript/Guide/Indexed_collections", "apply", "Student can use arrays and typed arrays to store and process ordered collections of data.", ["Web/JavaScript/Guide/Working_with_objects"]),
]

js_objs = []
for docPath, bloom, statement, prereq_paths in js_defs:
    ids = js_chunks.get(docPath, [])
    if not ids:
        print(f"WARNING javascript: no chunks matched for {docPath}", file=sys.stderr)
    js_objs.append({
        "id": jid(docPath),
        "track": "javascript",
        "unitId": jid(docPath),
        "bloomLevel": bloom,
        "statement": statement,
        "sourceDocIds": ids,
        "prerequisiteObjectiveIds": [jid(p) for p in prereq_paths],
    })

out = {"firmware": fw_objs, "rust": rust_objs, "javascript": js_objs}
with open(f"{TP}/content-packs/curriculum.json", "w") as f:
    json.dump(out, f, indent=2)

for track, objs in out.items():
    total_chunks = sum(len(o["sourceDocIds"]) for o in objs)
    print(f"{track}: {len(objs)} objectives, {total_chunks} total sourceDocIds mapped")
