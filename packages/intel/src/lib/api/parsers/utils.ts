/**
 * Shared helpers for the API route parsers.
 *
 * File discovery does not live here. The parsers ride the shared intel compiler
 * host's `findSourceFiles` for directory walking, so route scanning shares one
 * skip-directory policy with every other analyzer.
 *
 * @module lib/api/parsers/utils
 */

/**
 * Convert a character index to a 1-based line number in source content.
 * @param content - full source file content
 * @param index - character index position
 */
export function getLineNumber(content: string, index: number): number {
  return content.substring(0, index).split('\n').length;
}
