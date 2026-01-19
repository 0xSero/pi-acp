export function logInfo(message: string): void {
  process.stderr.write(`[pi-acp] ${message}\n`);
}

export function logWarn(message: string): void {
  process.stderr.write(`[pi-acp] WARN: ${message}\n`);
}

export function logError(message: string): void {
  process.stderr.write(`[pi-acp] ERROR: ${message}\n`);
}
