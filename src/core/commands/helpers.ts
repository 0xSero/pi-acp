export function normalizeThinkingLevelInput(value: string, levels: readonly string[]): string | null {
  const mapped = value === "extra-high" || value === "extra" ? "xhigh" : value;
  return levels.includes(mapped) ? mapped : null;
}

export function parseOnOff(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "on") {
    return true;
  }
  if (normalized === "off") {
    return false;
  }
  return null;
}
