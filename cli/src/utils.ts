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
