import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run an external executable with a hard timeout. Used for CameraControlRemoteCmd.exe
 * and ffmpeg calls, both of which can hang indefinitely if the device wedges -
 * without the timeout, a stuck child process would silently stall the health
 * poll loop and the fallback-within-3-seconds guarantee would break.
 */
export function execFile(
  exePath: string,
  args: string[],
  options: { timeoutMs: number; cwd?: string }
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, { cwd: options.cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Timed out after ${options.timeoutMs}ms: ${exePath} ${args.join(" ")}`));
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
