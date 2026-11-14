# TASK-000844: PROPERTIES header row comes from column tags, so moved or
# renamed columns map correctly and private columns can't slide into public
# slots. Run: python3 tests/generate-properties-test.py
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import generate_properties as g
fails = 0
def eq(name, got, want):
    global fails
    ok = got == want; fails += (not ok)
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f": got {got!r}, want {want!r}"))
keys = list(g.CANONICAL_BY_TAG)
live = [g.CANONICAL_BY_TAG[k] for k in keys]
meta = lambda order: [{"developerMetadata": {"metadataKey": f"iah.prop.{k}", "location": {"dimensionRange": {"sheetId": g.PROPS_GID, "startIndex": i}}}} for i, k in enumerate(order)]
eq("today: header row unchanged", g.canonical_header_row(live, meta(keys)), live)
moved = keys[:]; moved.insert(0, moved.pop(keys.index("lockbox")))   # Lock box dragged to column A
live_moved = [g.CANONICAL_BY_TAG[k] for k in moved]
live_moved[live_moved.index("Address")] = "Property Address"        # and Address renamed
out = g.canonical_header_row(live_moved, meta(moved))
eq("moved: Lock box found at A", out[0], "Lock box ")
eq("renamed: Address still labelled Address", out[moved.index("address")], "Address")
eq("moved: Available? shifted to B", out[1], "Available?")
try:
    g.canonical_header_row(live, meta([k for k in keys if k != "seller"])); eq("missing tag refuses", "no exit", "SystemExit")
except SystemExit as e:
    eq("missing tag refuses to publish", "seller" in str(e), True)
print(f"\n{fails} failed"); sys.exit(1 if fails else 0)
