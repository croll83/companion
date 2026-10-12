import { useEffect, useState } from "react";

/**
 * Whether a CSS media query matches, kept up to date. Without matchMedia
 * (jsdom in tests, very old browsers) it answers `fallback`.
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  const read = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback);
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
