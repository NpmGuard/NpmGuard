# NpmGuard contracts

Solidity contracts for on-chain audit payments on Base.

## Stack

- **Foundry** (`forge` + `cast`) — build, test, deploy
- **viem** is used in `engine/` and `cli/` to read/call the deployed contract

## 1. Install Foundry (one-time)

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

Check:

```bash
forge --version
cast --version
```

## 2. Setup (one-time)

```bash
cd contracts
forge install foundry-rs/forge-std
cp .env.example .env
# then edit .env and fill in:
#   DEPLOYER_PRIVATE_KEY    (throwaway testnet wallet)
#   BASE_SEPOLIA_RPC_URL    (Alchemy Base Sepolia URL)
#   BASESCAN_API_KEY        (https://basescan.org/myapikey — same as Etherscan V2 key)
```

## 3. Build

```bash
forge build
```

Outputs `out/NpmGuardAuditRequest.sol/NpmGuardAuditRequest.json` (ABI + bytecode).

## 4. Test

```bash
forge test -vvv
```

Runs 7 unit tests + 1 fuzz test (256 runs). Expected: `8 passed; 0 failed`.

Gas snapshot:

```bash
forge snapshot
```

## 5. Get your deployer address (from the private key in .env)

```bash
cast wallet address --private-key $(grep ^DEPLOYER_PRIVATE_KEY .env | cut -d= -f2)
```

Copy this address.

## 6. Fund the deployer on Base Sepolia

Paste the address above into one of these faucets (need ~0.01 ETH):

- https://www.alchemy.com/faucets/base-sepolia (requires Alchemy account)
- https://faucets.chain.link/base-sepolia
- https://docs.base.org/chain/network-faucets (full list)

Check balance:

```bash
cast balance <your-address> --rpc-url $BASE_SEPOLIA_RPC_URL
```

(prefix with `source .env &&` if `$BASE_SEPOLIA_RPC_URL` isn't loaded)

## 7. Deploy to Base Sepolia (with automatic Basescan verification)

```bash
./deploy.sh sepolia
```

This runs:

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast \
  --verify \
  --etherscan-api-key "$BASESCAN_API_KEY" \
  --chain base-sepolia \
  -vvvv
```

Expected output tail:

```
✅  [Success] Hash: 0x...
Contract Address: 0xYOUR_CONTRACT_ADDRESS
Block: ...
Paid: ~0.0002 ETH

...
Submitting verification for [src/NpmGuardAuditRequest.sol:NpmGuardAuditRequest]
Contract successfully verified
```

View it: `https://sepolia.basescan.org/address/0xYOUR_CONTRACT_ADDRESS`

## 8. After deploy — wire the address

Copy the deployed address into:

- `engine/.env` → `AUDIT_CONTRACT_ADDRESS=0x...`
- `cli/src/contract.ts` → `AUDIT_REQUEST_ADDRESS` constant

## Deploy to Base mainnet (later)

```bash
./deploy.sh mainnet
```

⚠️ Uses real ETH. Double-check `INITIAL_AUDIT_FEE_WEI` and make sure the deployer holds enough mainnet ETH.

## Manual verification (if `--verify` was skipped)

```bash
forge verify-contract <contract-address> \
  src/NpmGuardAuditRequest.sol:NpmGuardAuditRequest \
  --chain base-sepolia \
  --etherscan-api-key "$BASESCAN_API_KEY" \
  --constructor-args $(cast abi-encode "constructor(uint256)" 100000000000000)
```

## Interacting with the deployed contract from the CLI

Read current fee:

```bash
cast call <contract-address> "auditFee()(uint256)" --rpc-url $BASE_SEPOLIA_RPC_URL
```

Check if a package was already requested:

```bash
cast call <contract-address> "isRequested(string,string)(bool)" "express" "4.18.0" \
  --rpc-url $BASE_SEPOLIA_RPC_URL
```

Request an audit (sends a tx):

```bash
cast send <contract-address> "requestAudit(string,string)" "express" "4.18.0" \
  --value 0.0001ether \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --rpc-url $BASE_SEPOLIA_RPC_URL
```

## Troubleshooting

- **`insufficient funds for gas`** → le wallet deployer n'a pas d'ETH sur Base Sepolia. Retourne à l'étape 6.
- **`chain mismatch`** → ton `BASE_SEPOLIA_RPC_URL` pointe sur le mauvais réseau (ex: Ethereum Sepolia au lieu de Base Sepolia).
- **Verification `Unknown error`** → attends 30s que le bloc soit indexé par Basescan et relance manuellement (section "Manual verification" ci-dessus).
- **`nonce too low` / `replacement transaction underpriced`** → une ancienne tx est stuck dans ton wallet. Ouvre MetaMask → Settings → Advanced → Reset account.
