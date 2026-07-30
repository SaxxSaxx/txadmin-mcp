// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** FXServer console output is colourised; the codes are pure token waste here. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI, '');
}

/**
 * Render rows as an aligned text table.
 *
 * Tool results are read by a model, so the format optimises for compactness and
 * unambiguous column boundaries rather than for looking pretty in a terminal.
 */
export function table(rows: Record<string, unknown>[], columns: string[]): string {
  if (!rows.length) return '(no rows)';

  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((row) => cell(row[col]).length)),
  );

  const line = (values: string[]) =>
    values.map((value, i) => value.padEnd(widths[i])).join(' | ').trimEnd();

  return [
    line(columns),
    columns.map((_, i) => '-'.repeat(widths[i])).join('-+-'),
    ...rows.map((row) => line(columns.map((col) => cell(row[col])))),
  ].join('\n');
}

/** Cut long output, saying how much was dropped rather than truncating silently. */
export function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const omitted = input.length - maxChars;
  return `${input.slice(0, maxChars)}\n… [truncated, ${omitted} characters omitted]`;
}

/** Seconds-since-epoch to an ISO string, tolerating missing values. */
export function ts(seconds: number | undefined): string {
  if (!seconds) return 'unknown';
  return new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

/** Minutes to a compact human duration, as txAdmin stores playtime in minutes. */
export function minutes(value: number | undefined): string {
  if (value === undefined || value === null) return 'unknown';
  if (value < 60) return `${value}m`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
