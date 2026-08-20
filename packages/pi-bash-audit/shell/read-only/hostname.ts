export function validateHostname(args: readonly string[]): boolean {
  return args.length === 0 || args.every((arg) => arg === "-f" || arg === "-s");
}
