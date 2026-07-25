#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "error: contracts/.env not found. Copy .env.example and fill it in."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

: "${DEPLOYER_PRIVATE_KEY:?missing in .env}"

NETWORK="${1:-sepolia}"
CONTRACT="${2:-audit}"

usage() {
  echo "usage: $0 [sepolia|mainnet|0g-testnet|0g] [audit|attestations]"
  exit 1
}

# 0G chain ids verified against the live RPCs (eth_chainId → 0x40da / 0x4115).
# Galileo is 16602; most third-party sources still report a stale 16601.
case "$NETWORK" in
  sepolia)
    RPC_URL="${BASE_SEPOLIA_RPC_URL:?missing BASE_SEPOLIA_RPC_URL in .env}"
    CHAIN_NAME="base-sepolia"
    VERIFY=1
    ;;
  mainnet)
    RPC_URL="${BASE_RPC_URL:?missing BASE_RPC_URL in .env}"
    CHAIN_NAME="base"
    VERIFY=1
    echo "⚠️  Deploying to Base MAINNET. Press Ctrl+C within 5s to abort."
    sleep 5
    ;;
  0g-testnet)
    RPC_URL="${ZEROG_TESTNET_RPC_URL:-https://evmrpc-testnet.0g.ai}"
    CHAIN_NAME="16602"
    # 0G's explorer is not an Etherscan-compatible verification API, so --verify
    # would fail the whole broadcast. Verify separately via chainscan.
    VERIFY=0
    ;;
  0g)
    RPC_URL="${ZEROG_RPC_URL:-https://evmrpc.0g.ai}"
    CHAIN_NAME="16661"
    VERIFY=0
    echo "⚠️  Deploying to 0G MAINNET. Press Ctrl+C within 5s to abort."
    sleep 5
    ;;
  *) usage ;;
esac

case "$CONTRACT" in
  audit)
    : "${INITIAL_AUDIT_FEE_WEI:?missing in .env}"
    SCRIPT="script/Deploy.s.sol:Deploy"
    echo "→ Deploying NpmGuardAuditRequest to $NETWORK (fee=$INITIAL_AUDIT_FEE_WEI wei)"
    ;;
  attestations)
    SCRIPT="script/DeployAttestations.s.sol:DeployAttestations"
    echo "→ Deploying NpmGuardAttestations to $NETWORK"
    ;;
  *) usage ;;
esac
echo

ARGS=(
  --rpc-url "$RPC_URL"
  --private-key "$DEPLOYER_PRIVATE_KEY"
  --broadcast
  --chain "$CHAIN_NAME"
  -vvvv
)
if [ "$VERIFY" = "1" ]; then
  : "${BASESCAN_API_KEY:?missing in .env}"
  ARGS+=(--verify --etherscan-api-key "$BASESCAN_API_KEY")
fi

forge script "$SCRIPT" "${ARGS[@]}"

echo
echo "✓ Deployed. Copy the address above into:"
if [ "$CONTRACT" = "audit" ]; then
  echo "  - engine/.env — the setting for this chain (see engine/.env.template):"
  echo "      sepolia → NPMGUARD_BASE_SEPOLIA_CONTRACT"
  echo "      0g-testnet → NPMGUARD_ZEROG_TESTNET_CONTRACT"
  echo "  - cli/src/contract.ts is only a fallback; the CLI prefers /config/public"
else
  echo "  - engine/.env  (NPMGUARD_ZEROG_ATTESTATIONS_CONTRACT=0x...)"
fi
