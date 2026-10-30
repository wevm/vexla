/** @module React entry: `useFlag` reads a flag and renders again when the values change. */
import { useSyncExternalStore } from 'react'
import type * as Definitions from '../Definitions.js'
import type { Registered } from '../index.js'
import * as Values from '../Values.js'

/**
 * Returns the value of a flag: on the server, the value of the current request (inside
 * `Values.run`), and in a browser, the value of the page. It renders again after `Values.load`.
 */
export function useFlag<const key extends keyof Registered & string>(
  key: key,
): Definitions.Value<Registered[key]> {
  const read = () => Values.snapshot()[key] as Definitions.Value<Registered[key]>
  return useSyncExternalStore(Values.subscribe, read, read)
}
