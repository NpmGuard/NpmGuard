import { installationOctokit } from "./app.js";

// GitHub check runs (spec §5.10). Needs the App's Checks:write permission —
// if the App was registered without it, check calls fail; we log and carry
// on, the dashboard + email paths still work.

export async function createCheckRun(
  installationId: number,
  owner: string,
  repo: string,
  headSha: string,
): Promise<number | null> {
  try {
    const octo = await installationOctokit(installationId);
    const { data } = await octo.rest.checks.create({
      owner,
      repo,
      name: "NpmGuard",
      head_sha: headSha,
      status: "in_progress",
    });
    return data.id;
  } catch (err) {
    console.warn(
      `[checks] create failed for ${owner}/${repo}@${headSha.slice(0, 7)}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function concludeCheckRun(
  installationId: number,
  owner: string,
  repo: string,
  checkRunId: number,
  result: { conclusion: "success" | "failure"; title: string; summary: string },
): Promise<void> {
  try {
    const octo = await installationOctokit(installationId);
    await octo.rest.checks.update({
      owner,
      repo,
      check_run_id: checkRunId,
      status: "completed",
      conclusion: result.conclusion,
      output: { title: result.title, summary: result.summary },
    });
  } catch (err) {
    console.warn(
      `[checks] conclude failed for ${owner}/${repo}#${checkRunId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
