// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/NpmGuardAttestations.sol";

contract NpmGuardAttestationsTest is Test {
    NpmGuardAttestations internal registry;

    address internal owner = address(0xA11CE);
    address internal relayer = address(0xBEEF);
    address internal stranger = address(0xB0B);

    bytes32 internal constant NULLIFIER = bytes32(uint256(0x00117));
    bytes32 internal constant DIGEST = bytes32(uint256(0xD16E57));
    bytes32 internal constant ROOT = bytes32(uint256(0x0060));

    event ReleaseAttested(
        bytes32 indexed packageId,
        bytes32 indexed nullifier,
        string packageName,
        string version,
        uint8 tier,
        bytes32 artifactDigest,
        bytes32 storageRoot,
        uint64 attestedAt
    );

    function setUp() public {
        vm.prank(owner);
        registry = new NpmGuardAttestations();
        vm.prank(owner);
        registry.setVerifier(relayer, true);
    }

    function _attest(string memory version) internal {
        vm.prank(relayer);
        registry.attest("lodash", version, NULLIFIER, 2, DIGEST, ROOT);
    }

    function test_Deploy_OwnerIsAlsoTheFirstVerifier() public view {
        assertEq(registry.owner(), owner);
        assertTrue(registry.verifiers(owner));
    }

    function test_Attest_RecordsAndEmits() public {
        vm.expectEmit(true, true, false, true);
        emit ReleaseAttested(
            registry.packageId("lodash"),
            NULLIFIER,
            "lodash",
            "4.17.21",
            2,
            DIGEST,
            ROOT,
            uint64(block.timestamp)
        );
        _attest("4.17.21");

        NpmGuardAttestations.Attestation memory row = registry.attestationOf("lodash", "4.17.21");
        assertEq(row.nullifier, NULLIFIER);
        assertEq(row.artifactDigest, DIGEST);
        assertEq(row.storageRoot, ROOT);
        assertEq(row.tier, 2);
        assertEq(row.verifier, relayer);
        assertTrue(registry.isAttested("lodash", "4.17.21"));
        assertEq(registry.attestedCount(registry.packageId("lodash")), 1);
    }

    /// The core invariant: history cannot be rewritten. If it could, an attacker
    /// who reached the verifier key could manufacture a clean publisher streak
    /// retroactively, and the continuity signal would mean nothing.
    function test_Attest_RevertsOnOverwrite_EvenByAnotherVerifier() public {
        _attest("4.17.21");

        vm.prank(relayer);
        vm.expectRevert(NpmGuardAttestations.AlreadyAttested.selector);
        registry.attest("lodash", "4.17.21", NULLIFIER, 3, DIGEST, ROOT);

        vm.prank(owner);
        vm.expectRevert(NpmGuardAttestations.AlreadyAttested.selector);
        registry.attest("lodash", "4.17.21", bytes32(uint256(0xDEAD)), 1, DIGEST, ROOT);

        // the original row survives both attempts untouched
        assertEq(registry.attestationOf("lodash", "4.17.21").tier, 2);
        assertEq(registry.attestationOf("lodash", "4.17.21").nullifier, NULLIFIER);
    }

    function test_Attest_OnlyVerifier() public {
        vm.prank(stranger);
        vm.expectRevert(NpmGuardAttestations.NotVerifier.selector);
        registry.attest("lodash", "4.17.21", NULLIFIER, 1, DIGEST, ROOT);
    }

    function test_SetVerifier_OnlyOwner_AndRevocationStopsWrites() public {
        vm.prank(stranger);
        vm.expectRevert(NpmGuardAttestations.NotOwner.selector);
        registry.setVerifier(stranger, true);

        vm.prank(owner);
        registry.setVerifier(relayer, false);

        vm.prank(relayer);
        vm.expectRevert(NpmGuardAttestations.NotVerifier.selector);
        registry.attest("lodash", "4.17.21", NULLIFIER, 1, DIGEST, ROOT);
    }

    function test_Attest_RejectsUnusableRows() public {
        vm.startPrank(relayer);

        vm.expectRevert(abi.encodeWithSelector(NpmGuardAttestations.InvalidTier.selector, uint8(0)));
        registry.attest("lodash", "4.17.21", NULLIFIER, 0, DIGEST, ROOT);

        vm.expectRevert(abi.encodeWithSelector(NpmGuardAttestations.InvalidTier.selector, uint8(4)));
        registry.attest("lodash", "4.17.21", NULLIFIER, 4, DIGEST, ROOT);

        // no publisher identity → nothing to build continuity from
        vm.expectRevert(NpmGuardAttestations.EmptyField.selector);
        registry.attest("lodash", "4.17.21", bytes32(0), 1, DIGEST, ROOT);

        // no artifact binding → the row cannot say WHICH tarball was consented to
        vm.expectRevert(NpmGuardAttestations.EmptyField.selector);
        registry.attest("lodash", "4.17.21", NULLIFIER, 1, bytes32(0), ROOT);

        vm.expectRevert(NpmGuardAttestations.EmptyField.selector);
        registry.attest("", "4.17.21", NULLIFIER, 1, DIGEST, ROOT);

        vm.expectRevert(NpmGuardAttestations.EmptyField.selector);
        registry.attest("lodash", "", NULLIFIER, 1, DIGEST, ROOT);

        vm.stopPrank();
    }

    function test_UnattestedReleaseReadsAsAbsent() public view {
        assertFalse(registry.isAttested("lodash", "9.9.9"));
        assertEq(registry.attestationOf("lodash", "9.9.9").nullifier, bytes32(0));
        assertEq(registry.attestedCount(registry.packageId("never-seen")), 0);
    }

    function test_AttestedCountTracksAStreak() public {
        _attest("1.0.0");
        _attest("1.0.1");
        _attest("1.0.2");
        assertEq(registry.attestedCount(registry.packageId("lodash")), 3);
        // a different package keeps its own count
        assertEq(registry.attestedCount(registry.packageId("chalk")), 0);
    }

    /// `abi.encode` (not `encodePacked`) means no pair of (name, version) inputs
    /// can collide into one slot — a collision would let one release silently
    /// occupy another's row and forge a streak.
    function testFuzz_ReleaseIdNeverCollidesAcrossTheNameVersionBoundary(
        string calldata a,
        string calldata b,
        string calldata c
    ) public view {
        vm.assume(bytes(a).length != bytes(c).length);
        assertTrue(registry.releaseId(a, b) != registry.releaseId(c, b));
    }

    function testFuzz_AnyValidTierRoundTrips(uint8 tier, bytes32 nullifier) public {
        tier = uint8(bound(tier, 1, 3));
        vm.assume(nullifier != bytes32(0));

        vm.prank(relayer);
        registry.attest("pkg", "1.0.0", nullifier, tier, DIGEST, ROOT);

        NpmGuardAttestations.Attestation memory row = registry.attestationOf("pkg", "1.0.0");
        assertEq(row.tier, tier);
        assertEq(row.nullifier, nullifier);
    }
}
