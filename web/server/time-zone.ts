/**
 * Validation for the global `timeZone` setting (chat message times and day
 * separators). Lives apart from settings-manager so the settings routes can
 * validate with the real implementation even where settings-manager is mocked.
 */

/**
 * True for "" (Automatic: each device uses its own zone) or an IANA zone the
 * runtime's Intl knows. Anything else would make every browser's
 * Intl.DateTimeFormat throw, so it is rejected on update and dropped on load.
 */
export function isValidTimeZoneSetting(zone: string): boolean {
  if (zone === "") return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
