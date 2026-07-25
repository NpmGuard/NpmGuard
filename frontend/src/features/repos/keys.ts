/** Query keys for repositories and the audit sets over them.
 *
 * Public-repo audits live in this factory rather than in a feature of their own
 * because R-1 collapsed them into the SAME entity: a public audit is an audit set
 * whose subject happens to be a repo nobody here owns. They share the progress
 * stream, the rollup, and the dep projection — splitting the keys would imply a
 * split that does not exist in the data.
 *
 * See session/keys.ts for why these are factories rather than inline arrays. */
export const repoKeys = {
  all: ["repos"] as const,
  /** GET /panel/repos */
  list: () => [...repoKeys.all, "list"] as const,
  /** Prefix for every repo-detail entry — the handle for patching "whichever
   * detail pages are open" without knowing which owner/name they are. */
  details: () => [...repoKeys.all, "detail"] as const,
  /** GET /panel/repo/{owner}/{name} */
  detail: (owner: string, name: string) => [...repoKeys.details(), owner, name] as const,
  publicScans: () => [...repoKeys.all, "public"] as const,
  /** GET /panel/public-repos/{id} */
  publicScan: (scanId: number) => [...repoKeys.publicScans(), scanId] as const,
};
