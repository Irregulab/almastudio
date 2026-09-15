/** "3 minutes ago", in the page's language. */
export function relativeTime(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'], [3600, 'minute'], [86400, 'hour'],
    [86400 * 30, 'day'], [86400 * 365, 'month'], [Infinity, 'year'],
  ]
  const divisors = [1, 60, 3600, 86400, 86400 * 30, 86400 * 365]
  const rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || 'en', {
    numeric: 'auto',
  })
  for (let i = 0; i < units.length; i++) {
    if (diff < units[i][0]) return rtf.format(-Math.round(diff / divisors[i]), units[i][1])
  }
  return ''
}
