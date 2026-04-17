import { z } from "zod";

// npm package-name grammar per npm-validate-package-name.
export const PackageName = z
  .string()
  .min(1)
  .max(214)
  .regex(
    /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
    "Invalid npm package name",
  );

export const SemverVersion = z
  .string()
  .regex(/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/, "Invalid semver version");

export const AuditRequest = z.object({
  packageName: PackageName,
  version: SemverVersion.optional(),
});

export const CheckoutRequest = z.object({
  packageName: PackageName,
  version: SemverVersion.optional(),
  email: z.string().email().optional(),
});

/** When adding a new chain, extend the `chain` enum AND the `SupportedChain`
 *  union in chain.ts; the engine's payment gate in routes/audit.ts relies on
 *  both being in sync. */
export const StreamAuditRequest = z.object({
  packageName: PackageName.optional(),
  version: SemverVersion.optional(),
  stripeSessionId: z.string().optional(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Invalid txHash").optional(),
  chain: z.enum(["base-sepolia", "base"]).optional(),
});
