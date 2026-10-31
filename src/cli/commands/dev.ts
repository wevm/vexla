/** @module The `dev` command: serves the dev route for a flags file, with a store in memory. */
import { Cli, z } from 'incur'
import * as Http from 'node:http'
import * as NodeRequest from '../../node/Request.js'
import * as Vexla from '../../server/Vexla.js'
import * as Store from '../../server/Store.js'
import * as Context from '../Context.js'

export default Cli.command({
  description: 'Serves the dev route for .env.flags, for an application with no TypeScript server.',
  options: Context.file.extend({
    port: z.number().optional().describe('Port. Default: 4000'),
  }),
  async run(c) {
    try {
      const vexla = Vexla.create({
        definitions: Context.definitions(c.options),
        dev: true,
        store: Store.memory(),
      })
      const server = Http.createServer(NodeRequest.toNodeListener(vexla.fetch))
      const port = c.options.port ?? 4000
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
      if (!c.agent) console.log(`Dev route: http://127.0.0.1:${port}${vexla.path}`)
      await new Promise(() => {})
      return {}
    } catch (error) {
      return c.error(Context.error(error))
    }
  },
})
