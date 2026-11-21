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
# Featured (2026-11-20): optional, by tag, anywhere in the row.
fm = meta(keys) + [{"developerMetadata": {"metadataKey": "iah.prop.featured", "location": {"dimensionRange": {"sheetId": g.PROPS_GID, "startIndex": 34}}}}]
eq("featured tag found", g.optional_tag_positions(fm), {"featured": 34})
eq("no featured tag: nothing, no error", g.optional_tag_positions(meta(keys)), {})
eq("featured tag doesn't disturb the required header check", g.canonical_header_row(live, fm)[:34], live)
eq("checkbox TRUE counts", [g.is_checked("TRUE"), g.is_checked("FALSE"), g.is_checked(""), g.is_checked(" true ")], [True, False, False, True])
# Card banner + price reduced (2026-11-21)
eq("banner trimmed and capped", g.clean_banner("  New   roof!  " + "x" * 80)[:12], "New roof! xx")
eq("banner cap is 60", len(g.clean_banner("y" * 100)), 60)
P = lambda d, m, on=None: {"down": d, "monthly": m, **({"priceReducedOn": on} if on else {})}
eq("new listing: no banner", g.price_reduced_on(None, "$2,000", "$800", "2026-11-21"), None)
eq("upfront drops: today", g.price_reduced_on(P("$2,000", "$800"), "$1,500", "$800", "2026-11-21"), "2026-11-21")
eq("monthly drops: today", g.price_reduced_on(P("$2,000", "$800"), "$2,000", "$750", "2026-11-21"), "2026-11-21")
eq("one down, one up: not a reduction", g.price_reduced_on(P("$2,000", "$800"), "$1,500", "$900", "2026-11-21"), None)
eq("unchanged: keeps the date", g.price_reduced_on(P("$1,500", "$800", "2026-11-10"), "$1,500", "$800", "2026-11-21"), "2026-11-10")
eq("14 days later: gone", g.price_reduced_on(P("$1,500", "$800", "2026-11-07"), "$1,500", "$800", "2026-11-21"), None)
eq("price goes back up: gone", g.price_reduced_on(P("$1,500", "$800", "2026-11-20"), "$2,000", "$800", "2026-11-21"), None)
eq("blank price: no banner", g.price_reduced_on(P("", "$800"), "$1,500", "$800", "2026-11-21"), None)
print(f"\n{fails} failed"); sys.exit(1 if fails else 0)
