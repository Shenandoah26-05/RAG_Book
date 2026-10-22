import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** `git rev-parse HEAD`, or null outside a repository (or without git). */
export async function currentGitCommit(): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
