// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/NpmGuardAttestations.sol";

/// @notice Deploys the publisher-attestation registry and, when
///         `ATTESTATION_VERIFIER` is set, allowlists the engine relayer that
///         will record attestations. The deployer is always a verifier, so
///         leaving it unset yields a working single-key setup.
contract DeployAttestations is Script {
    function run() external returns (NpmGuardAttestations deployed) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address relayer = vm.envOr("ATTESTATION_VERIFIER", address(0));

        vm.startBroadcast(deployerKey);
        deployed = new NpmGuardAttestations();
        if (relayer != address(0)) {
            deployed.setVerifier(relayer, true);
        }
        vm.stopBroadcast();

        console.log("NpmGuardAttestations deployed at:", address(deployed));
        console.log("Owner:", deployed.owner());
        if (relayer != address(0)) {
            console.log("Verifier allowlisted:", relayer);
        }
    }
}
