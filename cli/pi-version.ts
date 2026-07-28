export const PI_COMPATIBILITY = ">=0.82.0 <0.83.0";

export interface ParsedPiVersion { major: number; minor: number; patch: number }

export function parsePiVersion(output: string): ParsedPiVersion | null {
  const match = output.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:\s|$|-)/);
  if (!match) return null;
  const values = match.slice(1, 4).map(Number);
  if (values.some((value) => !Number.isSafeInteger(value))) return null;
  return { major: values[0]!, minor: values[1]!, patch: values[2]! };
}

export function supportsPiVersion(output: string): boolean {
  const version = parsePiVersion(output);
  return !!version && version.major === 0 && version.minor === 82;
}
