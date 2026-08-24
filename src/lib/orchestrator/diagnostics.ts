const SECRET_KEY = /(password|secret|token|api[_-]?key|service[_-]?role|anon|private[_-]?key|access[_-]?key|jwt)/i;
const SECRET_PATTERNS = [
  /\b(?:eyJ|sb_)[A-Za-z0-9_\-.=]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(?:postgres(?:ql)?:\/\/)[^\s"']+/gi,
];

export function sanitizeText(input: string, extraSecrets: readonly string[] = []): string {
  let output = input;
  for (const secret of [...extraSecrets].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join("[REDACTED]");
  }
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, "[REDACTED]");
  // Common dotenv/CLI output: keep the key name but not the value.
  output = output.replace(/(^|[\s,{])([A-Z][A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|KEY)[A-Z0-9_]*)\s*[:=]\s*([^\s,}]+)/gim, "$1$2=[REDACTED]");
  return output;
}

/** Keep both the command context and the actionable final error. */
export function boundedDiagnosticText(input: string, maximumLength = 4_000): string {
  if (input.length <= maximumLength) return input;
  if (maximumLength < 80) return input.slice(-maximumLength);
  const marker = "\n... diagnostic output omitted ...\n";
  const remaining = maximumLength - marker.length;
  const headLength = Math.floor(remaining / 3);
  return `${input.slice(0, headLength)}${marker}${input.slice(-(remaining - headLength))}`;
}

export function sanitizeValue(value: unknown, extraSecrets: readonly string[] = []): unknown {
  if (typeof value === "string") return sanitizeText(value, extraSecrets);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, extraSecrets));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = SECRET_KEY.test(key) ? "[REDACTED]" : sanitizeValue(item, extraSecrets);
    return result;
  }
  return value;
}

export interface DiagnosticReport {
  readonly projectId: string;
  readonly stage: string;
  readonly service?: string;
  readonly message: string;
  readonly health?: unknown;
  readonly logs?: string;
  readonly createdAt: string;
}

export function sanitizeDiagnostic(report: DiagnosticReport, secrets: readonly string[] = []): DiagnosticReport {
  return sanitizeValue(report, secrets) as DiagnosticReport;
}
