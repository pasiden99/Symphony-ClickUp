export function resolveLoginShell(env: NodeJS.ProcessEnv = process.env): string {
  const shell = env.SHELL?.trim();
  return shell && shell !== "" ? shell : "bash";
}
