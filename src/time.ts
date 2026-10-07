const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

export function relativeTime({ timestamp, now = Date.now() }: { timestamp: number; now?: number }) {
  const difference = timestamp - now;
  for (const [unit, duration] of units) {
    if (Math.abs(difference) >= duration)
      return relativeTimeFormat.format(Math.trunc(difference / duration), unit);
  }
  return "just now";
}
