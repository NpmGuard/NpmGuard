import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function parsePackageArg(pkg: string): { name: string; version?: string } {
  if (pkg.startsWith("@")) {
    const slashIndex = pkg.indexOf("/");
    if (slashIndex === -1) {
      throw new Error(`Invalid scoped package name: ${pkg}`);
    }
    const rest = pkg.slice(slashIndex + 1);
    const atIndex = rest.lastIndexOf("@");
    if (atIndex > 0) {
      return {
        name: pkg.slice(0, slashIndex + 1 + atIndex),
        version: rest.slice(atIndex + 1),
      };
    }
    return { name: pkg };
  }

  const atIndex = pkg.lastIndexOf("@");
  if (atIndex > 0) {
    return {
      name: pkg.slice(0, atIndex),
      version: pkg.slice(atIndex + 1),
    };
  }

  return { name: pkg };
}

/**
 * A package name as a URL PATH: each segment encoded, the scope slash kept.
 *
 * `/package/*` and `/resolve/*` are splat routes, so the slash in `@scope/pkg`
 * is structure the engine matches on. Encoding the whole name to `%2F` leaves
 * the request depending on the ASGI layer decoding it before routing — a
 * behaviour a proxy in front is free to change. Mirrors `ops.py::_package_path`.
 */
export function packagePath(packageName: string): string {
  return packageName.split("/").map(encodeURIComponent).join("/");
}

export function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

export async function resolveLatestVersion(packageName: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

export function detectPackageManager(cwd: string = process.cwd()): "npm" | "pnpm" | "yarn" {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}
