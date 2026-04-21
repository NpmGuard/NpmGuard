import { dockerExec } from "../sandbox/docker.js";

/**
 * Write a file inside a running container by piping base64 through `base64 -d`.
 * Avoids shell-escaping issues for content containing quotes, newlines, or binary bytes.
 */
export async function writeFileInContainer(
  containerName: string,
  absPath: string,
  content: string | Buffer,
): Promise<void> {
  const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  const encoded = buf.toString("base64");
  const quotedPath = shellQuote(absPath);
  const script = `mkdir -p "$(dirname ${quotedPath})" && printf '%s' '${encoded}' | base64 -d > ${quotedPath}`;
  const res = await dockerExec(["exec", containerName, "sh", "-c", script], 15_000);
  if (res.exitCode !== 0) {
    throw new Error(
      `writeFileInContainer(${absPath}) failed: ${res.stderr.slice(0, 300)}`,
    );
  }
}

/** Read a file from inside a running container as a UTF-8 string. */
export async function readFileInContainer(containerName: string, absPath: string): Promise<string> {
  const res = await dockerExec(["exec", containerName, "cat", absPath], 15_000);
  if (res.exitCode !== 0) {
    throw new Error(`readFileInContainer(${absPath}) failed: ${res.stderr.slice(0, 300)}`);
  }
  return res.stdout;
}

/** Single-quote a string for safe shell interpolation. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
