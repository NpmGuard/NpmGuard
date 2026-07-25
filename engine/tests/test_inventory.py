# CLASS MAP — inventory's manifest boundary (analyze_inventory / load_manifest;
# pure filesystem, no LLM, no seams)
# Axes: manifest health × whether the audit may continue
#   C1  a real manifest → metadata / scripts / entryPoints / dependencies as shipped
#   C2  unparseable JSON (truncated object) → AuditIncompleteError, stage
#       "inventory", NPMGUARD-0031, retryable — and NO InventoryReport, so nothing
#       downstream can read an empty manifest as a clean one
#   C3  unreadable manifest (absent; a directory in its place) → same class,
#       located as "could not be read" rather than "not valid JSON"
#   C4  valid JSON that is not an object (`[]`, `null`, `"x"`, `7`) → same class.
#       This used to escape as an AttributeError on `package.get` → NPMGUARD-9999,
#       non-retryable HTTP 500.
#   C5  bytes that are not UTF-8 → the same content class, never an unmapped
#       UnicodeDecodeError (also a 9999 before)
#   C6  a UTF-8 BOM parses (npm tolerates one) — the classes above must not turn a
#       merely byte-prefixed manifest into a failed audit
#   C7  the swallow this replaces, stated as the state it produced: name/version
#       None, no scripts, entryPoints.runtime == ["index.js"], dealbreaker None —
#       an audit that looks complete with zero manifest knowledge. Asserted as
#       unreachable: no input in C2-C5 can return an InventoryReport at all.
# Axes deliberately NOT this file's subject: file classification and the
# structural checks / dealbreakers of run_inventory_checks are unchanged here and
# are exercised through run_flag (test_fail_fast, test_hypothesis_generation).
# FINDING (reported, not silently absorbed): no test in the suite covers the
# dealbreaker verdict path at all — `grep -rl dealbreaker tests/` is empty.
import json

import pytest

from npmguard.errors import AuditIncompleteError
from npmguard.inventory import analyze_inventory

VALID = {
    "name": "left-pad",
    "version": "1.3.0",
    "main": "lib/index.js",
    "scripts": {"preinstall": "node setup.js", "build": "tsc"},
    "dependencies": {"ms": "^2.0.0"},
}


def _write(tmp_path, content: bytes | str):
    package = tmp_path / "package"
    package.mkdir()
    target = package / "package.json"
    if isinstance(content, bytes):
        target.write_bytes(content)
    else:
        target.write_text(content, encoding="utf-8")
    (package / "setup.js").write_text("module.exports = 1;\n", encoding="utf-8")
    return package


async def _incomplete(package) -> AuditIncompleteError:
    with pytest.raises(AuditIncompleteError) as excinfo:
        await analyze_inventory(package)
    assert excinfo.value.stage == "inventory"
    assert excinfo.value.code == "NPMGUARD-0031"
    assert excinfo.value.retryable is True
    assert excinfo.value.http_status == 503
    return excinfo.value


async def test_real_manifest_is_read_as_shipped(tmp_path) -> None:
    """C1: the happy path — every manifest-derived field comes from the file."""
    inventory = await analyze_inventory(_write(tmp_path, json.dumps(VALID)))
    assert (inventory.metadata.name, inventory.metadata.version) == ("left-pad", "1.3.0")
    assert inventory.scripts == VALID["scripts"]
    assert inventory.entryPoints.install == ["setup.js"]
    assert inventory.entryPoints.runtime == ["lib/index.js"]
    assert inventory.dependencies["prod"] == {"ms": "^2.0.0"}


async def test_unparseable_manifest_fails_loud(tmp_path) -> None:
    """C2: a truncated manifest ends the audit with a located 0031 (C7: and
    therefore never returns the empty-manifest inventory it used to)."""
    error = await _incomplete(_write(tmp_path, '{"name": "broken", "version":'))
    assert "not valid JSON" in str(error)


async def test_absent_manifest_fails_loud(tmp_path) -> None:
    """C3a: no package.json at all is an unreadable manifest, not an empty one."""
    package = tmp_path / "package"
    package.mkdir()
    error = await _incomplete(package)
    assert "could not be read" in str(error)
    assert "FileNotFoundError" in str(error)


async def test_manifest_that_is_a_directory_fails_loud(tmp_path) -> None:
    """C3b: the other OSError shape (a directory where the manifest belongs) —
    chosen over chmod-000 because that one silently passes as root."""
    package = tmp_path / "package"
    (package / "package.json").mkdir(parents=True)
    error = await _incomplete(package)
    assert "could not be read" in str(error)


@pytest.mark.parametrize("body", ["[]", "null", '"a string"', "7"])
async def test_manifest_that_is_not_an_object_fails_loud(tmp_path, body: str) -> None:
    """C4: valid JSON of the wrong kind is a manifest defect, not a 500."""
    error = await _incomplete(_write(tmp_path, body))
    assert "not a JSON object" in str(error)


async def test_manifest_with_invalid_encoding_fails_loud(tmp_path) -> None:
    """C5: undecodable bytes are classified here, not raised as a bare
    UnicodeDecodeError that the service maps to a non-retryable 9999."""
    error = await _incomplete(_write(tmp_path, b'{"name": "\xff\xfe caf\xe9"}'))
    assert "not valid JSON" in str(error)


async def test_manifest_with_utf8_bom_still_parses(tmp_path) -> None:
    """C6: a BOM-prefixed manifest is a real manifest — failing it would be a new
    false negative in the opposite direction."""
    inventory = await analyze_inventory(
        _write(tmp_path, b"\xef\xbb\xbf" + json.dumps(VALID).encode("utf-8"))
    )
    assert inventory.metadata.name == "left-pad"
