/**
 * @module Scans `.env.flags`: dotenv lines, each with the comment lines directly above it. Tags
 * such as `@type {boolean}` live in those comments.
 */

/** One `NAME=value` line, with the comment lines directly above it. */
export type Entry = {
  /** The comment lines above the variable, without `#`. A blank line ends a comment block. */
  comments: readonly string[]
  /** The 0-based index of the first line of the entry: its first comment line, or the variable. */
  start: number
  /** The 0-based index of the variable line. */
  end: number
  /** The 1-based line number of the variable, for errors. */
  line: number
  /** The variable name. */
  name: string
  /** The value, with surrounding quotes removed. */
  value: string
}

/** A tag in a comment line, such as `@type {'a' | 'b'}` or `@public`. */
export type Tag = {
  /** The text in braces, or the word after the tag, if any. */
  argument?: string | undefined
  /** The tag name, without `@`. */
  name: string
}

/**
 * Returns the entries of `text`. A line that is neither blank, a comment, nor `NAME=value` is
 * reported with its 1-based line number.
 */
export function scan(text: string): { entries: Entry[]; invalid: number[] } {
  const lines = text.split(/\r?\n/)
  const entries: Entry[] = []
  const invalid: number[] = []
  let comments: string[] = []
  let start: number | undefined

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()

    if (line === '') {
      comments = []
      start = undefined
      continue
    }

    if (line.startsWith('#')) {
      comments.push(line.replace(/^#\s?/, ''))
      start ??= index
      continue
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) {
      invalid.push(index + 1)
      comments = []
      start = undefined
      continue
    }

    entries.push({
      comments,
      end: index,
      line: index + 1,
      name: match[1]!,
      start: start ?? index,
      value: unquote(match[2]!),
    })
    comments = []
    start = undefined
  }

  return { entries, invalid }
}

/**
 * Returns the tags of a comment line that starts with `@`, or `undefined` for a description line.
 * Several tags may share a line: `@type {boolean} @public @build`.
 */
export function tags(comment: string): Tag[] | undefined {
  const text = comment.trim()
  if (!text.startsWith('@')) return undefined

  const result: Tag[] = []
  let rest = text
  while (rest.length > 0) {
    const name = /^@([A-Za-z]+)/.exec(rest)
    if (!name) {
      result.push({ argument: rest, name: '' })
      break
    }
    rest = rest.slice(name[0].length).trimStart()

    const argument = (() => {
      if (rest.startsWith('{')) {
        const end = rest.indexOf('}')
        if (end === -1) return undefined
        const value = rest.slice(1, end)
        rest = rest.slice(end + 1).trimStart()
        return value.trim()
      }
      if (rest !== '' && !rest.startsWith('@')) {
        const word = /^\S+/.exec(rest)![0]
        rest = rest.slice(word.length).trimStart()
        return word
      }
      return undefined
    })()

    result.push({ argument, name: name[1]! })
  }
  return result
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}
