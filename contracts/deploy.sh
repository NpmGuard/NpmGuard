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
: "${BASE_SEPOLIA_RPC_URL:?missing in .env}"
: "${BASESCAN_API_KEY:?missing in .env}"
: "${INITIAL_AUDIT_FEE_WEI:?missing in .env}"

NETWORK="${1:-sepolia}"

case "$NETWORK" in
  sepolia)
    RPC_URL="$BASE_SEPOLIA_RPC_URL"
    CHAIN_NAME="base-sepolia"
    ;;
  mainnet)
    RPC_URL="${BASE_RPC_URL:?missing BASE_RPC_URL in .env}"
    CHAIN_NAME="base"
    echo "⚠️  Deploying to Base MAINNET. Press Ctrl+C within 5s to abort."
    sleep 5
    ;;
  *)
    echo "usage: $0 [sepolia|mainnet]"
    exit 1
    ;;
esac

echo "→ Deploying NpmGuardAuditRequest to $NETWORK (fee=$INITIAL_AUDIT_FEE_WEI wei)"
echo

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast \
  --verify \
  --etherscan-api-key "$BASESCAN_API_KEY" \
  --chain "$CHAIN_NAME" \
  -vvvv

echo
echo "✓ Deployed. Copy the address above into:"
echo "  - engine/.env  (AUDIT_CONTRACT_ADDRESS=0x...)"
echo "  - cli/src/contract.ts"
