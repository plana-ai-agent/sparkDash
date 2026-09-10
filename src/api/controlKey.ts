const STORAGE_KEY = "sparkdash.eco.key";

/** ECO and Local LLM controls share one key, including when storage is blocked. */
export function requestControlKey(message: string): string | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)?.trim();
    if (stored) return stored;
  } catch { /* blocked storage */ }
  return window.prompt(message, "")?.trim() || null;
}

export function storeControlKey(key: string) {
  try { localStorage.setItem(STORAGE_KEY, key); } catch { /* blocked storage */ }
}

export function clearControlKey() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* blocked storage */ }
}
