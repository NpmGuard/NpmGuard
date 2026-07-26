// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/NpmGuardAuditRequest.sol";

contract NpmGuardAuditRequestTest is Test {
    NpmGuardAuditRequest internal contractUnderTest;
    address internal owner = address(0xA11CE);
    address internal user = address(0xB0B);
    uint256 internal constant FEE = 0.0001 ether;

    event AuditRequested(
        string packageName,
        string version,
        address indexed requester,
        uint256 feePaid
    );

    function setUp() public {
        vm.prank(owner);
        contractUnderTest = new NpmGuardAuditRequest(FEE);
        vm.deal(user, 1 ether);
    }

    function test_Deploy_SetsOwnerAndFee() public view {
        assertEq(contractUnderTest.owner(), owner);
        assertEq(contractUnderTest.auditFee(), FEE);
    }

    function test_RequestAudit_HappyPath_EmitsEventAndFlagsRequested() public {
        vm.expectEmit(true, false, false, true);
        emit AuditRequested("express", "4.18.0", user, FEE);

        vm.prank(user);
        contractUnderTest.requestAudit{value: FEE}("express", "4.18.0");

        assertTrue(contractUnderTest.isRequested("express", "4.18.0"));
        assertEq(address(contractUnderTest).balance, FEE);
    }

    function test_RequestAudit_RefundsExcess() public {
        uint256 balBefore = user.balance;

        vm.prank(user);
        contractUnderTest.requestAudit{value: FEE * 3}("lodash", "4.17.21");

        assertEq(address(contractUnderTest).balance, FEE);
        assertEq(user.balance, balBefore - FEE);
    }

    function test_RequestAudit_RevertsWhenFeeTooLow() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                NpmGuardAuditRequest.InsufficientFee.selector,
                FEE,
                FEE - 1
            )
        );
        contractUnderTest.requestAudit{value: FEE - 1}("express", "4.18.0");
    }

    function test_RequestAudit_RevertsWhenAlreadyRequested() public {
        vm.prank(user);
        contractUnderTest.requestAudit{value: FEE}("express", "4.18.0");

        vm.prank(user);
        vm.expectRevert(NpmGuardAuditRequest.AlreadyRequested.selector);
        contractUnderTest.requestAudit{value: FEE}("express", "4.18.0");
    }

    function test_SetFee_OnlyOwner() public {
        vm.prank(user);
        vm.expectRevert(NpmGuardAuditRequest.NotOwner.selector);
        contractUnderTest.setFee(0);

        vm.prank(owner);
        contractUnderTest.setFee(0.001 ether);
        assertEq(contractUnderTest.auditFee(), 0.001 ether);
    }

    function test_Withdraw_OnlyOwner_TransfersBalance() public {
        vm.prank(user);
        contractUnderTest.requestAudit{value: FEE}("express", "4.18.0");

        uint256 ownerBalBefore = owner.balance;

        vm.prank(user);
        vm.expectRevert(NpmGuardAuditRequest.NotOwner.selector);
        contractUnderTest.withdraw();

        vm.prank(owner);
        contractUnderTest.withdraw();

        assertEq(address(contractUnderTest).balance, 0);
        assertEq(owner.balance, ownerBalBefore + FEE);
    }

    function testFuzz_RequestAudit_RefundsExcess(uint96 extra) public {
        vm.assume(extra < 1 ether);
        uint256 value = FEE + extra;
        vm.deal(user, value);

        uint256 balBefore = user.balance;
        vm.prank(user);
        contractUnderTest.requestAudit{value: value}("pkg", "1.0.0");

        assertEq(user.balance, balBefore - FEE);
        assertEq(address(contractUnderTest).balance, FEE);
    }

    // The request key must identify exactly one (packageName, version).
    // 
    // `abi.encodePacked` concatenates dynamic types with no length prefix, so
    // `packageName + "@" + version` is ambiguous whenever a scoped name puts a
    // second `@` in the string: ("@scope/pkg", "1.0.0") and ("", "scope/pkg@1.0.0")
    // both flatten to "@scope/pkg@1.0.0".
    // 
    // That is not cosmetic. `requestAudit` is permissionless and the key is a
    // PERMANENT one-shot flag, so for one fee anybody can burn the slot of any
    // scoped package and lock its real request out of `AlreadyRequested` forever.
    // The attacker gains nothing — the engine matches the decoded name against the
    // audit it was asked for — which makes it pure griefing.
    function test_RequestAudit_ScopedNameCannotBeGriefedByKeyCollision() public {
        // The griefer front-runs with a split that flattens to the same string.
        vm.prank(user);
        contractUnderTest.requestAudit{value: FEE}("", "scope/pkg@1.0.0");

        // The real request must still be available.
        assertFalse(contractUnderTest.isRequested("@scope/pkg", "1.0.0"));
        vm.prank(user);
        contractUnderTest.requestAudit{value: FEE}("@scope/pkg", "1.0.0");
        assertTrue(contractUnderTest.isRequested("@scope/pkg", "1.0.0"));
    }

    // The one-shot guard still holds for a scoped package's own replay.
    function test_RequestAudit_ScopedNameIsStillOneShot() public {
        vm.startPrank(user);
        contractUnderTest.requestAudit{value: FEE}("@scope/pkg", "1.0.0");
        vm.expectRevert(NpmGuardAuditRequest.AlreadyRequested.selector);
        contractUnderTest.requestAudit{value: FEE}("@scope/pkg", "1.0.0");
        vm.stopPrank();
    }
}
