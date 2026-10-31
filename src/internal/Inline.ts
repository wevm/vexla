/**
 * @module Rewrites reads of flags in source with the TypeScript compiler API. `flags.key` (from
 * `vexla`) and `useFlag('key')` (from `vexla/react`) become literals. Bundlers, zile, and
 * `vexla retire` share it, since `define` cannot replace a member of an imported binding.
 */
import ts from 'typescript'
import type * as Definitions from '../Definitions.js'

/** A read that the rewrite reports. */
export type Finding = {
  /** The key of the flag. */
  key: string
  /** The 1-based line of the read. */
  line: number
  /** `private`: a private flag read in browser code. `runtime`: a read that stays, where none may. `dynamic`: a read with a computed key. */
  reason: 'dynamic' | 'private' | 'runtime'
}

/** The result of a rewrite. */
export type Result = {
  /** The rewritten code. Equal to the input when nothing changed. */
  code: string
  /** Reads that the caller may need to report. */
  findings: readonly Finding[]
}

/**
 * Replaces each read of a flag in `values` with its value as a literal. With `prune`, an `if`
 * statement or a conditional expression whose condition becomes a literal keeps only the branch
 * that runs. The `flags` and `useFlag` imports are removed once no read uses them.
 */
export function transform(code: string, options: transform.Options): Result {
  const kind = /\.[cm]?tsx$|\.jsx$/.test(options.file)
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(options.file)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS
  const source = ts.createSourceFile(options.file, code, ts.ScriptTarget.Latest, true, kind)

  const names = imports(source)
  if (!names.flags && !names.useFlag) return { code, findings: [] }

  const edits: Edit[] = []
  const findings: Finding[] = []
  const line = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

  // Returns the key that `node` reads, or undefined when `node` is not a flag read.
  const read = (node: ts.Node): string | undefined => {
    if (
      names.flags &&
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === names.flags
    )
      return node.name.text
    if (
      names.flags &&
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === names.flags
    ) {
      if (ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text
      findings.push({ key: '', line: line(node), reason: 'dynamic' })
      return undefined
    }
    if (
      names.useFlag &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === names.useFlag
    ) {
      const argument = node.arguments[0]
      if (argument && ts.isStringLiteralLike(argument)) return argument.text
      findings.push({ key: '', line: line(node), reason: 'dynamic' })
      return undefined
    }
    return undefined
  }

  const literal = (value: Definitions.Json) => {
    const text = JSON.stringify(value)
    return typeof value === 'object' && value !== null ? `(${text})` : text
  }

  // Returns `true` or `false` when `node` is a flag read (or its negation) with a boolean value.
  const constant = (node: ts.Expression): boolean | undefined => {
    const inner = ts.isParenthesizedExpression(node) ? node.expression : node
    if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.ExclamationToken) {
      const value = constant(inner.operand)
      return value === undefined ? undefined : !value
    }
    const key = read(inner)
    if (key === undefined || !(key in options.values)) return undefined
    const value = options.values[key]
    return typeof value === 'boolean' ? value : undefined
  }

  let remaining = 0

  const visit = (node: ts.Node): void => {
    if (options.prune && ts.isIfStatement(node)) {
      const value = constant(node.expression)
      if (value !== undefined) {
        const branch = value ? node.thenStatement : node.elseStatement
        edits.push({
          end: node.getEnd(),
          start: node.getStart(source),
          text: branch ? unwrap(branch, source) : '',
        })
        return
      }
    }

    if (options.prune && ts.isConditionalExpression(node)) {
      const value = constant(node.condition)
      if (value !== undefined) {
        const branch = value ? node.whenTrue : node.whenFalse
        edits.push({
          end: node.getEnd(),
          start: node.getStart(source),
          text: branch.getText(source),
        })
        return
      }
    }

    // `!flags.key` with a boolean value folds to the opposite literal.
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      const value = constant(node)
      if (value !== undefined) {
        edits.push({ end: node.getEnd(), start: node.getStart(source), text: String(value) })
        return
      }
    }

    const key = read(node)
    if (key !== undefined) {
      const definition = options.definitions[key]
      if (key in options.values) {
        edits.push({
          end: node.getEnd(),
          start: node.getStart(source),
          text: literal(options.values[key]!),
        })
        return
      }
      remaining++
      if (definition && options.browser && !definition.public)
        findings.push({ key, line: line(node), reason: 'private' })
      if (options.strict) findings.push({ key, line: line(node), reason: 'runtime' })
      return
    }

    if (
      ts.isIdentifier(node) &&
      (node.text === names.flags || node.text === names.useFlag) &&
      !isImportName(node)
    )
      remaining++
    ts.forEachChild(node, visit)
  }

  for (const statement of source.statements)
    if (!ts.isImportDeclaration(statement)) visit(statement)
  if (edits.length === 0) return { code, findings }

  // Removes the import specifiers that no read uses after the rewrite.
  if (remaining === 0) for (const edit of names.edits) edits.push(edit)

  return { code: apply(code, edits), findings }
}

export declare namespace transform {
  type Options = {
    /** `true` for browser code, where a read of a private flag is a finding. */
    browser?: boolean | undefined
    /** The definitions of the project. */
    definitions: Definitions.Definitions
    /** The file name, which selects the syntax (`.ts`, `.tsx`, `.js`). */
    file: string
    /** Keep only the branch that runs, where a condition becomes a literal. @default false */
    prune?: boolean | undefined
    /** Report every read that stays as a `runtime` finding. @default false */
    strict?: boolean | undefined
    /** The values that replace reads, keyed by flag key. */
    values: Readonly<Record<string, Definitions.Json>>
  }
}

type Edit = { end: number; start: number; text: string }

// The local names of `flags` from `vexla` and `useFlag` from `vexla/react`, and the edits that remove them.
function imports(source: ts.SourceFile): {
  edits: Edit[]
  flags?: string | undefined
  useFlag?: string | undefined
} {
  const result: { edits: Edit[]; flags?: string; useFlag?: string } = { edits: [] }

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const module = statement.moduleSpecifier.text
    const target = module === 'vexla' ? 'flags' : module === 'vexla/react' ? 'useFlag' : undefined
    const bindings = statement.importClause?.namedBindings
    if (!target || !bindings || !ts.isNamedImports(bindings)) continue

    const specifier = bindings.elements.find(
      (element) => (element.propertyName ?? element.name).text === target,
    )
    if (!specifier) continue
    result[target] = specifier.name.text

    const only = bindings.elements.length === 1 && !statement.importClause?.name
    if (only) {
      // The import line, and one blank line after it, are removed.
      const newlines = /^\n\n?/.exec(source.text.slice(statement.getEnd()))?.[0].length ?? 0
      result.edits.push({
        end: statement.getEnd() + newlines,
        start: statement.getStart(source),
        text: '',
      })
      continue
    }

    // Removes the specifier and the comma that follows it, or the comma before the last one.
    const index = bindings.elements.indexOf(specifier)
    const next = bindings.elements[index + 1]
    const previous = bindings.elements[index - 1]
    if (next)
      result.edits.push({ end: next.getStart(source), start: specifier.getStart(source), text: '' })
    else if (previous)
      result.edits.push({ end: specifier.getEnd(), start: previous.getEnd(), text: '' })
  }

  return result
}

function isImportName(node: ts.Identifier): boolean {
  return ts.isImportSpecifier(node.parent)
}

// A block keeps its statements without braces, so declarations stay in the enclosing scope only
// when the block held none. Otherwise the block stays.
function unwrap(statement: ts.Statement, source: ts.SourceFile): string {
  if (!ts.isBlock(statement)) return statement.getText(source)
  const declares = statement.statements.some(
    (inner) =>
      ts.isVariableStatement(inner) ||
      ts.isFunctionDeclaration(inner) ||
      ts.isClassDeclaration(inner),
  )
  if (declares || statement.statements.length === 0)
    return declares ? statement.getText(source) : ''
  const first = statement.statements[0]!
  const last = statement.statements[statement.statements.length - 1]!
  return source.text.slice(first.getStart(source), last.getEnd())
}

function apply(code: string, edits: readonly Edit[]): string {
  // Edits inside a replaced range are dropped, so a pruned branch is not edited twice.
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: Edit[] = []
  for (const edit of sorted) {
    const last = kept[kept.length - 1]
    if (last && edit.start < last.end) continue
    kept.push(edit)
  }

  let result = code
  for (const edit of kept.reverse())
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  return result
}
