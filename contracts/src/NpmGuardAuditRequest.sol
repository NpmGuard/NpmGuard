// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title NpmGuardAuditRequest
/// @notice Users pay a fee to request an on-chain audit for an npm package.
///         The engine watches `AuditRequested` events and triggers off-chain audits.
contract NpmGuardAuditRequest {
    event AuditRequested(
        string packageName,
        string version,
        address indexed requester,
        uint256 feePaid
    );

    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event OwnerTransferred(address indexed oldOwner, address indexed newOwner);

    error NotOwner();
    error InsufficientFee(uint256 required, uint256 provided);
    error AlreadyRequested();
    error RefundFailed();
    error WithdrawFailed();

    address public owner;
    uint256 public auditFee;

    /// @notice keccak256(packageName, "@", version) => already requested
    mapping(bytes32 => bool) public requested;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(uint256 _auditFee) {
        owner = msg.sender;
        auditFee = _auditFee;
    }

    /// @notice Pay `auditFee` to request an audit for (packageName, version).
    ///         Excess ETH is refunded. Each (pkg, version) can only be requested once.
    function requestAudit(
        string calldata packageName,
        string calldata version
    ) external payable {
        if (msg.value < auditFee) revert InsufficientFee(auditFee, msg.value);

        bytes32 key = keccak256(abi.encodePacked(packageName, "@", version));
        if (requested[key]) revert AlreadyRequested();
        requested[key] = true;

        emit AuditRequested(packageName, version, msg.sender, auditFee);

        uint256 excess = msg.value - auditFee;
        if (excess > 0) {
            (bool ok, ) = payable(msg.sender).call{value: excess}("");
            if (!ok) revert RefundFailed();
        }
    }

    function isRequested(
        string calldata packageName,
        string calldata version
    ) external view returns (bool) {
        return requested[keccak256(abi.encodePacked(packageName, "@", version))];
    }

    function setFee(uint256 _fee) external onlyOwner {
        uint256 old = auditFee;
        auditFee = _fee;
        emit FeeUpdated(old, _fee);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address old = owner;
        owner = newOwner;
        emit OwnerTransferred(old, newOwner);
    }

    function withdraw() external onlyOwner {
        (bool ok, ) = payable(owner).call{value: address(this).balance}("");
        if (!ok) revert WithdrawFailed();
    }
}
