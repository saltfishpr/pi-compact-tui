export function validateDate(args: readonly string[]): boolean {
  return (
    args.length === 0 ||
    (args.length === 1 && (args[0] === "-u" || args[0].startsWith("+"))) ||
    (args.length === 2 && args[0] === "-u" && args[1].startsWith("+"))
  );
}
