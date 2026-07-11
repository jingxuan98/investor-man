// Client-safe helper: reads the user's BYO Gemini key from localStorage (set
// via components/GeminiKeyButton.tsx) and returns it as a fetch header.
// Guarded for SSR (typeof window check) since components using this can
// render server-side before hydration.
export const GEMINI_KEY_STORAGE_KEY = "gemini_api_key";

export function geminiHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const key = window.localStorage.getItem(GEMINI_KEY_STORAGE_KEY)?.trim();
  return key ? { "x-gemini-key": key } : {};
}
