// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title NpmGuardAttestations
/// @notice Append-only registry of human-attested npm releases.
///
///         A maintainer proves, per release, that a real and unique human was
///         physically present and consented to one exact tarball — via a World
///         ID Identity Check proof whose `signal` is bound to
///         (package, version, tarball digest). That proof cannot be verified
///         on-chain, so the chain records the next best thing: an allowlisted
///         verifier's statement that it DID verify one, plus the 0G Storage root
///         of the evidence envelope so anyone can fetch and re-check it.
///
///         The value of this registry is continuity, not any single row. A
///         package whose last 40 releases were attested by publisher N, and
///         whose 41st is attested by nobody, is the signal — and a worm holding
///         a stolen npm token cannot produce that 41st proof.
///
/// @dev    APPEND-ONLY BY DESIGN. There is no revoke and no overwrite: a
///         registry whose history can be rewritten cannot support a continuity
///         claim, because an attacker who reaches the verifier key could
///         retroactively manufacture a clean streak. A mistaken attestation is
///         answered on the audit-verdict axis, never by editing this one.
contract NpmGuardAttestations {
    /// @param tier 1 = proof of human; 2 = document-backed identity check;
    ///        3 = identity check + declared jurisdiction. Higher is stronger.
    /// @param nullifier the World ID per-app/per-action pseudonym. Stable for a
    ///        person forever and linkable to nothing outside this app — it is
    ///        the durable publisher identity, deliberately NOT a name, a wallet,
    ///        or a GitHub login (all three get compromised; this does not).
    /// @param artifactDigest binds the row to one exact tarball, so an
    ///        attestation cannot be replayed onto a different artifact.
    /// @param storageRoot 0G Storage merkle root of the evidence envelope.
    struct Attestation {
        bytes32 nullifier;
        bytes32 artifactDigest;
        bytes32 storageRoot;
        uint8 tier;
        uint64 attestedAt;
        address verifier;
    }

    /// @notice `packageId` and `nullifier` are indexed so anyone can independently
    ///         reconstruct both halves of the continuity signal — every release of
    ///         a package, and every release by a publisher — without trusting our API.
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

    event VerifierSet(address indexed verifier, bool allowed);
    event OwnerTransferred(address indexed oldOwner, address indexed newOwner);

    error NotOwner();
    error NotVerifier();
    error AlreadyAttested();
    error InvalidTier(uint8 tier);
    error EmptyField();
    error ZeroAddress();

    address public owner;

    /// @notice Addresses permitted to record an attestation. The World proof is
    ///         verified off-chain against the World API, so this allowlist is
    ///         what stops anyone from writing arbitrary rows.
    mapping(address => bool) public verifiers;

    /// @notice releaseId => the attestation. Never overwritten.
    mapping(bytes32 => Attestation) private _attestations;

    /// @notice packageId => number of attested releases, so a reader can size a
    ///         history scan without replaying every log.
    mapping(bytes32 => uint256) public attestedCount;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyVerifier() {
        if (!verifiers[msg.sender]) revert NotVerifier();
        _;
    }

    constructor() {
        owner = msg.sender;
        verifiers[msg.sender] = true;
        emit VerifierSet(msg.sender, true);
    }

    /// @notice Key for one release.
    /// @dev `abi.encode`, not `abi.encodePacked`: packed encoding of two dynamic
    ///      strings is ambiguous, and a collision here would let one release
    ///      silently occupy another's slot. Length-prefixed encoding cannot collide.
    function releaseId(
        string calldata packageName,
        string calldata version
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(packageName, version));
    }

    function packageId(string calldata packageName) public pure returns (bytes32) {
        return keccak256(bytes(packageName));
    }

    /// @notice Record that a verified human attested `packageName@version`.
    /// @dev Reverts rather than overwriting — see the append-only note above.
    function attest(
        string calldata packageName,
        string calldata version,
        bytes32 nullifier,
        uint8 tier,
        bytes32 artifactDigest,
        bytes32 storageRoot
    ) external onlyVerifier {
        if (bytes(packageName).length == 0 || bytes(version).length == 0) revert EmptyField();
        if (tier == 0 || tier > 3) revert InvalidTier(tier);
        // A row without these is unverifiable: no publisher identity, or no way
        // to tell which tarball was consented to.
        if (nullifier == bytes32(0) || artifactDigest == bytes32(0)) revert EmptyField();

        bytes32 key = releaseId(packageName, version);
        if (_attestations[key].nullifier != bytes32(0)) revert AlreadyAttested();

        uint64 attestedAt = uint64(block.timestamp);
        _attestations[key] = Attestation({
            nullifier: nullifier,
            artifactDigest: artifactDigest,
            storageRoot: storageRoot,
            tier: tier,
            attestedAt: attestedAt,
            verifier: msg.sender
        });

        bytes32 pkgId = packageId(packageName);
        unchecked {
            ++attestedCount[pkgId];
        }

        emit ReleaseAttested(
            pkgId,
            nullifier,
            packageName,
            version,
            tier,
            artifactDigest,
            storageRoot,
            attestedAt
        );
    }

    function attestationOf(
        string calldata packageName,
        string calldata version
    ) external view returns (Attestation memory) {
        return _attestations[releaseId(packageName, version)];
    }

    function isAttested(
        string calldata packageName,
        string calldata version
    ) external view returns (bool) {
        return _attestations[releaseId(packageName, version)].nullifier != bytes32(0);
    }

    function setVerifier(address verifier, bool allowed) external onlyOwner {
        if (verifier == address(0)) revert ZeroAddress();
        verifiers[verifier] = allowed;
        emit VerifierSet(verifier, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address old = owner;
        owner = newOwner;
        emit OwnerTransferred(old, newOwner);
    }
}
