/**
 * Rendering for the CLI's output. Pure, so the rounding, the column widths and
 * what a failure prints can be asserted rather than eyeballed.
 */

import { Cause, Option, Predicate, Runtime } from 'effect'

/** Stands in for any value a running VM did not report. */
export const missing = '-'

const UNITS = ['B', 'K', 'M', 'G', 'T'] as const

/**
 * Binary units, with one decimal only below 10 — enough to tell 3.4G from 3.9G,
 * while keeping the column narrow once the figure is large enough that the
 * decimal says nothing.
 */
export const bytes = (value: number | undefined): string => {
  if (value === undefined) return missing
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < UNITS.length - 1) {
    scaled /= 1024
    unit++
  }
  const digits = unit > 0 && scaled < 10 ? scaled.toFixed(1) : String(Math.round(scaled))
  return `${digits}${UNITS[unit]}`
}

/**
 * A VM's broker, as `ls` shows it: `-` for none, else its state, with how
 * often it has been started again and how many of the VM's processes the
 * kernel killed for memory — which is the likeliest reason it had to be.
 */
export const broker = (
  status:
    | {
        readonly oomKills: number
        readonly restarts: number
        readonly state: 'restarting' | 'running' | 'stopped'
      }
    | undefined,
): string => {
  if (status === undefined) return missing
  const parts: Array<string> = [status.state === 'running' ? 'up' : status.state]
  if (status.state === 'running' && status.restarts > 0) {
    parts.push(`restarted ${String(status.restarts)}×`)
  }
  if (status.oomKills > 0) {
    parts.push(`${String(status.oomKills)} killed for memory`)
  }
  return parts.join(', ')
}

/**
 * Coarse and two-term at most: this exists to make "up for six days" obvious at
 * a glance, and a seconds figure on a week-old VM is noise.
 */
export const duration = (millis: number | undefined): string => {
  if (millis === undefined) return missing
  const seconds = Math.max(0, Math.floor(millis / 1000))
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (minutes === 0) return `${seconds}s`
  if (hours === 0) return `${minutes}m`
  if (days === 0) return `${hours}h ${minutes % 60}m`
  return `${days}d ${hours % 24}h`
}

/**
 * Left-aligned columns, two spaces apart, each as wide as its widest cell. The
 * last column is not padded, so a long path does not leave trailing whitespace
 * on every line above it.
 */
export const table = (headers: readonly string[], rows: readonly (readonly string[])[]): string => {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map(row => (row[column] ?? '').length)),
  )
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) =>
        column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0),
      )
      .join('  ')
  return [line(headers), ...rows.map(line)].join('\n')
}

/**
 * What a command that failed prints: its error's message as an `igloo:` line,
 * and where its boot record is when the message did not already say.
 *
 * Nothing for an interruption, whose exit status says it, or for an error the
 * CLI has rendered itself — a usage error, printed with the help text. A defect
 * is a bug rather than a failure, so it keeps its whole report: the stack is the
 * only evidence of where it came from.
 */
export const failure = (cause: Cause.Cause<unknown>): string | undefined => {
  if (Cause.hasInterruptsOnly(cause)) return undefined
  if (!Runtime.getErrorReported(Cause.squash(cause))) return undefined
  const found = Cause.findErrorOption(cause)
  if (Option.isNone(found)) return `igloo: internal error\n${Cause.pretty(cause)}\n`
  const error = found.value
  const message = error instanceof Error ? error.message : String(error)
  const record =
    Predicate.hasProperty(error, 'bootRecord') && typeof error.bootRecord === 'string'
      ? `igloo: the boot record is ${error.bootRecord}\n`
      : ''
  return `igloo: ${message}\n${record}`
}
