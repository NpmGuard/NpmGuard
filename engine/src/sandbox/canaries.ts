// Canary credentials planted in verify and preflight sandboxes.
//
// Why: malware exfil paths are gated on credentials being present
// (env vars, ~/.npmrc, AWS creds, etc.). Without canaries the malicious
// code path does nothing observable and verify tests fail with
// "expected false to be true" — not because the test is wrong, but
// because there's nothing to steal.
//
// These tokens are:
// - Realistic enough to pass shape regexes (npm_*, ghp_*, AKIA*)
// - Marked with `NPMGUARD_CANARY` so any leak is unambiguous
// - Stable across runs so test-gen prompts can hard-code them

export const CANARY = {
  NPM_TOKEN: "npm_NPMGUARD_CANARYaaaaaaaaaaaaaaaaaaaaaa",
  GITHUB_TOKEN: "ghp_NPMGUARD_CANARYbbbbbbbbbbbbbbbbbbbbbb",
  GH_TOKEN: "ghp_NPMGUARD_CANARYbbbbbbbbbbbbbbbbbbbbbb",
  AWS_ACCESS_KEY_ID: "AKIANPMGUARDCANARY01",
  AWS_SECRET_ACCESS_KEY: "NPMGUARD_CANARY/SECRET/dddddddddddddddddd",
  AWS_SESSION_TOKEN: "NPMGUARD_CANARY_SESSION_eeeeeeeeeeeee",
  GOOGLE_APPLICATION_CREDENTIALS: "/workspace/home/.config/gcloud/canary-creds.json",
  HOME: "/workspace/home",
} as const;

/** Docker `-e` flags for `docker run` to inject canaries. */
export function canaryEnvFlags(): string[] {
  return [
    "-e", `NPM_TOKEN=${CANARY.NPM_TOKEN}`,
    "-e", `GITHUB_TOKEN=${CANARY.GITHUB_TOKEN}`,
    "-e", `GH_TOKEN=${CANARY.GH_TOKEN}`,
    "-e", `AWS_ACCESS_KEY_ID=${CANARY.AWS_ACCESS_KEY_ID}`,
    "-e", `AWS_SECRET_ACCESS_KEY=${CANARY.AWS_SECRET_ACCESS_KEY}`,
    "-e", `AWS_SESSION_TOKEN=${CANARY.AWS_SESSION_TOKEN}`,
    "-e", `GOOGLE_APPLICATION_CREDENTIALS=${CANARY.GOOGLE_APPLICATION_CREDENTIALS}`,
    "-e", `HOME=${CANARY.HOME}`,
  ];
}

export interface PlantedFile {
  relativePath: string;
  content: string;
}

/** Files to plant under the workdir so HOME-rooted reads find canary content. */
export function canaryPlantedFiles(): PlantedFile[] {
  return [
    {
      relativePath: "home/.npmrc",
      content: `//registry.npmjs.org/:_authToken=${CANARY.NPM_TOKEN}\n`,
    },
    {
      relativePath: "home/.config/gcloud/canary-creds.json",
      content: JSON.stringify(
        {
          type: "service_account",
          project_id: "npmguard-canary-project",
          private_key_id: "NPMGUARD_CANARY_KEY_ID",
          private_key: "-----BEGIN PRIVATE KEY-----\nNPMGUARD_CANARY_PRIVATE_KEY\n-----END PRIVATE KEY-----\n",
          client_email: "canary@npmguard-canary-project.iam.gserviceaccount.com",
        },
        null,
        2,
      ),
    },
    {
      relativePath: "home/.aws/credentials",
      content: `[default]\naws_access_key_id=${CANARY.AWS_ACCESS_KEY_ID}\naws_secret_access_key=${CANARY.AWS_SECRET_ACCESS_KEY}\n`,
    },
  ];
}
