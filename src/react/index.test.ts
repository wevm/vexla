/** @module Renders useFlag on the server inside a request scope. */
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { Definitions, Values } from 'flargs'
import { useFlag } from 'flargs/react'
import { Flargs } from 'flargs/server'

const definitions = Definitions.parse({
  NEW_CHECKOUT: { default: false, public: true, type: 'boolean' },
})

function Checkout() {
  return createElement('p', null, useFlag('NEW_CHECKOUT' as never) ? 'new' : 'old')
}

describe('useFlag', () => {
  test('reads the value of the request on the server', async () => {
    const flargs = Flargs.create({ definitions, dev: true })
    const render = (url: string) =>
      Values.run(flargs, new Request(url), () => renderToString(createElement(Checkout)))

    expect(await render('https://app.example.com/?flag.NEW_CHECKOUT=true')).toMatchInlineSnapshot(
      `"<p>new</p>"`,
    )
    expect(await render('https://app.example.com/')).toMatchInlineSnapshot(`"<p>old</p>"`)
  })
})
