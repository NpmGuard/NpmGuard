# CLASS MAP — panel.lockfile (pure: string in → list[LockfileDep] out; no IO)
# Unit = parse_lockfile / manifest_ranges / LOCKFILE_CANDIDATES / UnsupportedLockfileError.
# Axes: format (npm v2/v3, pnpm v5/v6/v9, yarn classic/berry, unknown) ×
#       dep role (direct+range / transitive+null) ×
#       name shape (plain / scoped @org/pkg / nested node_modules) ×
#       dedup (same name@version twice → one) ×
#       skip (workspace link / workspace dir / non-registry resolution) ×
#       failure (npm v1, invalid JSON, unparseable yaml, unknown filename, garbage manifest)
#   C1  npm v3: direct dep → version + direct=True + range from root "" entry
#   C2  npm v3: nested node_modules dep → direct=False, range=None
#   C3  npm v3: scoped @types/node under node_modules → name kept, direct
#   C4  npm: link:true entries and non-node_modules workspace dirs are skipped
#   C5  npm: identical (name, version) at two paths → deduped to one
#   C6  npm v2: packages-map shape (lockfileVersion 2) parses like v3
#   C7  npm: direct range absent from root entry falls back to the manifest
#   C8  npm v1 (no packages key) → UnsupportedLockfileError naming "npm >= 7"
#   C9  npm invalid JSON → UnsupportedLockfileError
#   C10 pnpm v9: scoped + peer-suffixed keys; direct range from importer specifier
#   C11 pnpm v6: leading-slash "@" keys
#   C12 pnpm v5: slash-separated keys, underscore peer suffix; direct from root sections
#   C13 pnpm: unparseable / non-mapping yaml → UnsupportedLockfileError
#   C14 yarn classic: direct classification from manifest; unlisted → transitive
#   C15 yarn classic: multi-spec comma header + scoped name
#   C16 yarn berry: deps via resolution "@npm:"; workspace: resolutions skipped
#   C17 manifest_ranges: collects across sections, first section wins
#   C18 manifest_ranges: garbage (None / non-JSON string / non-object) → empty, no raise
#   C19 parse_lockfile dispatch: unknown filename → error naming supported formats
#   C20 LOCKFILE_CANDIDATES: the ordered candidate filenames
# Adversarial pass: W1 — "which dimension is missing?" → the manifest-fallback
#   dimension for direct-range on npm (C7) and the multi-spec yarn header (C15)
#   were added; both are real lockfile shapes the single-spec fixtures hid.
import json

import pytest

from npmguard.panel.lockfile import (
    LOCKFILE_CANDIDATES,
    UnsupportedLockfileError,
    manifest_ranges,
    parse_lockfile,
)


def _by_name(deps):
    return {d.name: d for d in deps}


# ---------------------------------------------------------------- npm v2/v3 ---

NPM_V3 = json.dumps(
    {
        "name": "fixture",
        "lockfileVersion": 3,
        "packages": {
            "": {
                "dependencies": {"express": "^4.18.0"},
                "devDependencies": {"@types/node": "^22.0.0"},
            },
            "node_modules/express": {"version": "4.18.2"},
            "node_modules/@types/node": {"version": "22.1.0"},
            "node_modules/express/node_modules/qs": {"version": "6.11.0"},
            "node_modules/linked-pkg": {"version": "1.0.0", "link": True},
            "packages/workspace-a": {"version": "0.0.1"},
        },
    }
)


def test_npm_v3_direct_dep_carries_version_and_range():
    """C1: npm v3 direct dep → version + direct=True + range from root entry."""
    express = _by_name(parse_lockfile("package-lock.json", NPM_V3))["express"]
    assert (express.version, express.direct, express.range) == ("4.18.2", True, "^4.18.0")


def test_npm_v3_nested_dep_is_transitive_with_null_range():
    """C2: nested node_modules dep → direct=False, range=None."""
    qs = _by_name(parse_lockfile("package-lock.json", NPM_V3))["qs"]
    assert (qs.version, qs.direct, qs.range) == ("6.11.0", False, None)


def test_npm_v3_scoped_name_preserved():
    """C3: scoped @types/node under node_modules → name kept, direct."""
    types = _by_name(parse_lockfile("package-lock.json", NPM_V3))["@types/node"]
    assert (types.version, types.direct) == ("22.1.0", True)


def test_npm_skips_links_and_workspace_dirs():
    """C4: link:true entries and non-node_modules workspace dirs are skipped."""
    names = _by_name(parse_lockfile("package-lock.json", NPM_V3))
    assert "linked-pkg" not in names
    assert "workspace-a" not in names


def test_npm_dedupes_identical_name_version():
    """C5: identical (name, version) at two paths → one dep."""
    lock = json.dumps(
        {
            "lockfileVersion": 3,
            "packages": {
                "": {},
                "node_modules/a": {"version": "1.0.0"},
                "node_modules/b/node_modules/a": {"version": "1.0.0"},
            },
        }
    )
    deps = [d for d in parse_lockfile("package-lock.json", lock) if d.name == "a"]
    assert len(deps) == 1


def test_npm_v2_packages_map_parses():
    """C6: npm v2 packages-map shape parses like v3."""
    lock = json.dumps(
        {
            "lockfileVersion": 2,
            "packages": {
                "": {"dependencies": {"lodash": "^4.17.0"}},
                "node_modules/lodash": {"version": "4.17.21"},
            },
        }
    )
    lodash = _by_name(parse_lockfile("package-lock.json", lock))["lodash"]
    assert (lodash.version, lodash.direct, lodash.range) == ("4.17.21", True, "^4.17.0")


def test_npm_direct_range_falls_back_to_manifest():
    """C7: direct range absent from the root entry falls back to the manifest."""
    lock = json.dumps(
        {
            "lockfileVersion": 3,
            "packages": {"": {}, "node_modules/lodash": {"version": "4.17.21"}},
        }
    )
    manifest = manifest_ranges('{"dependencies": {"lodash": "^4.17.21"}}')
    lodash = _by_name(parse_lockfile("package-lock.json", lock, manifest))["lodash"]
    assert (lodash.direct, lodash.range) == (True, "^4.17.21")


def test_npm_v1_rejected_with_regenerate_hint():
    """C8: npm v1 (no packages key) → UnsupportedLockfileError naming npm >= 7."""
    v1 = json.dumps({"lockfileVersion": 1, "dependencies": {}})
    with pytest.raises(UnsupportedLockfileError, match="npm >= 7"):
        parse_lockfile("package-lock.json", v1)


def test_npm_invalid_json_rejected():
    """C9: npm invalid JSON → UnsupportedLockfileError."""
    with pytest.raises(UnsupportedLockfileError):
        parse_lockfile("package-lock.json", "not json{")


# ---------------------------------------------------------------------- pnpm ---

PNPM_V9 = """
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      lodash:
        specifier: ^4.17.21
        version: 4.17.21
packages:
  lodash@4.17.21:
    resolution: {integrity: sha512-x}
  '@babel/core@7.20.0(supports-color@9.0.0)':
    resolution: {integrity: sha512-y}
"""

PNPM_V6 = """
lockfileVersion: '6.0'
importers:
  .:
    dependencies:
      lodash:
        specifier: ^4.17.21
        version: 4.17.21
packages:
  /lodash@4.17.21:
    resolution: {integrity: sha512-x}
  '/@scope/pkg@1.2.3':
    resolution: {integrity: sha512-y}
"""

PNPM_V5 = """
lockfileVersion: 5.4
dependencies:
  lodash: 4.17.21
packages:
  /lodash/4.17.21:
    resolution: {integrity: sha512-x}
  /@scope/pkg/1.2.3_react@18.0.0:
    resolution: {integrity: sha512-y}
"""


def test_pnpm_v9_scoped_and_peer_suffix():
    """C10: pnpm v9 scoped + peer-suffixed keys; direct range from importer."""
    by = _by_name(parse_lockfile("pnpm-lock.yaml", PNPM_V9))
    assert (by["lodash"].version, by["lodash"].direct, by["lodash"].range) == (
        "4.17.21",
        True,
        "^4.17.21",
    )
    assert (by["@babel/core"].version, by["@babel/core"].direct) == ("7.20.0", False)


def test_pnpm_v6_leading_slash_at_keys():
    """C11: pnpm v6 leading-slash "@" keys."""
    by = _by_name(parse_lockfile("pnpm-lock.yaml", PNPM_V6))
    assert by["lodash"].version == "4.17.21"
    assert by["@scope/pkg"].version == "1.2.3"


def test_pnpm_v5_slash_keys_with_peer_suffix():
    """C12: pnpm v5 slash-separated keys, underscore peer suffix; direct from root."""
    by = _by_name(parse_lockfile("pnpm-lock.yaml", PNPM_V5))
    assert (by["lodash"].version, by["lodash"].direct) == ("4.17.21", True)
    assert by["@scope/pkg"].version == "1.2.3"


def test_pnpm_unparseable_rejected():
    """C13: pnpm non-mapping / unparseable yaml → UnsupportedLockfileError."""
    with pytest.raises(UnsupportedLockfileError):
        parse_lockfile("pnpm-lock.yaml", "just a scalar string")
    with pytest.raises(UnsupportedLockfileError):
        parse_lockfile("pnpm-lock.yaml", "key: [unclosed")


# ---------------------------------------------------------------------- yarn ---

YARN_CLASSIC = """# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


lodash@^4.17.21, lodash@^4.0.0:
  version "4.17.21"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#hash"
  integrity sha512-x

"@scope/pkg@^1.0.0":
  version "1.0.1"
  resolved "https://registry.yarnpkg.com/@scope/pkg/-/pkg-1.0.1.tgz#hash"
  integrity sha512-y
"""

YARN_BERRY = """# This file is generated by running "yarn install"

__metadata:
  version: 8
  cacheKey: 10

"lodash@npm:^4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"

"@scope/pkg@npm:^1.0.0":
  version: 1.0.1
  resolution: "@scope/pkg@npm:1.0.1"

"my-workspace@workspace:.":
  version: 0.0.0-use.local
  resolution: "my-workspace@workspace:."
"""

YARN_MANIFEST = manifest_ranges('{"dependencies": {"lodash": "^4.17.21"}}')


def test_yarn_classic_manifest_classifies_direct():
    """C14/C15: yarn classic multi-spec + scoped; direct from manifest, else transitive."""
    by = _by_name(parse_lockfile("yarn.lock", YARN_CLASSIC, YARN_MANIFEST))
    assert (by["lodash"].version, by["lodash"].direct, by["lodash"].range) == (
        "4.17.21",
        True,
        "^4.17.21",
    )
    assert (by["@scope/pkg"].version, by["@scope/pkg"].direct) == ("1.0.1", False)


def test_yarn_berry_via_resolution_skips_workspace():
    """C16: yarn berry deps via resolution "@npm:"; workspace: resolutions skipped."""
    by = _by_name(parse_lockfile("yarn.lock", YARN_BERRY, YARN_MANIFEST))
    assert by["lodash"].version == "4.17.21"
    assert by["@scope/pkg"].version == "1.0.1"
    assert "my-workspace" not in by


# ------------------------------------------------------- manifest + dispatch ---


def test_manifest_ranges_first_section_wins():
    """C17: manifest_ranges collects across sections, first section wins."""
    ranges = manifest_ranges(
        json.dumps(
            {
                "dependencies": {"a": "^1.0.0"},
                "devDependencies": {"a": "^2.0.0", "b": "~3.0.0"},
            }
        )
    )
    assert ranges["a"] == "^1.0.0"
    assert ranges["b"] == "~3.0.0"


def test_manifest_ranges_tolerates_garbage():
    """C18: garbage manifest input → empty mapping, never raises."""
    assert manifest_ranges(None) == {}
    assert manifest_ranges("not json{") == {}
    assert manifest_ranges("[1, 2, 3]") == {}  # valid JSON, not an object


def test_unknown_filename_names_supported_formats():
    """C19: unknown filename → error naming package-lock.json/pnpm-lock.yaml/yarn.lock."""
    with pytest.raises(UnsupportedLockfileError) as exc:
        parse_lockfile("bun.lockb", "")
    msg = str(exc.value)
    assert "package-lock.json" in msg
    assert "pnpm-lock.yaml" in msg
    assert "yarn.lock" in msg


def test_lockfile_candidates_order():
    """C20: LOCKFILE_CANDIDATES is the ordered candidate filename tuple."""
    assert LOCKFILE_CANDIDATES == ("package-lock.json", "pnpm-lock.yaml", "yarn.lock")
