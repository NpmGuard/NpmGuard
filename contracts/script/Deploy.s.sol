// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/NpmGuardAuditRequest.sol";

contract Deploy is Script {
    function run() external returns (NpmGuardAuditRequest deployed) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 initialFee = vm.envUint("INITIAL_AUDIT_FEE_WEI");

        vm.startBroadcast(deployerKey);
        deployed = new NpmGuardAuditRequest(initialFee);
        vm.stopBroadcast();

        console.log("NpmGuardAuditRequest deployed at:", address(deployed));
        console.log("Initial audit fee (wei):", initialFee);
        console.log("Owner:", deployed.owner());
    }
}
