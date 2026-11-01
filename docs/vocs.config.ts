/** @module Vocs configuration of the documentation site: navigation, links, and metadata. */
import { defineConfig } from 'vocs/config'

export default defineConfig({
  description: 'Feature flags for trunk-based development.',
  editLink: {
    link: 'https://github.com/wevm/vexla/edit/main/docs/src/pages/:path',
    text: 'Suggest changes to this page',
  },
  iconUrl: '/favicon.svg',
  // The sidebar order is the reading order, so its entries keep their authored order.
  sidebar: [
    {
      items: [
        { link: '/introduction/getting-started', text: 'Getting Started' },
        { link: '/introduction/why-vexla', text: 'Why Vexla' },
        { link: '/introduction/concepts', text: 'Concepts' },
      ],
      text: 'Introduction',
    },
    {
      items: [
        { link: '/guides/flags-file', text: 'Flags File and Environment Variables' },
        { link: '/guides/hono', text: 'Hono' },
        { link: '/guides/nextjs', text: 'Next.js' },
        { link: '/guides/cloudflare-workers', text: 'Cloudflare Workers' },
        { link: '/guides/node', text: 'Node' },
        { link: '/guides/react', text: 'React' },
        { link: '/guides/vite', text: 'Vite' },
        { link: '/guides/vitest', text: 'Vitest' },
        { link: '/guides/libraries', text: 'Libraries with zile' },
        { link: '/guides/admin-api', text: 'Admin API and Authorization' },
        { link: '/guides/store-definitions', text: 'Store Definitions' },
        { link: '/guides/retirement', text: 'Retirement' },
        { link: '/guides/rust', text: 'Rust' },
      ],
      text: 'Guides',
    },
    {
      items: [
        {
          items: [
            { link: '/api/core', text: 'Overview' },
            { link: '/api/core/flags', text: 'flags' },
            { link: '/api/core/definitions', text: 'Definitions' },
            { link: '/api/core/override', text: 'Override' },
            { link: '/api/core/values', text: 'Values' },
            { link: '/api/core/register', text: 'Register' },
          ],
          text: 'vexla',
        },
        {
          items: [
            { link: '/api/server', text: 'Overview' },
            { link: '/api/server/vexla/create', text: 'Vexla.create' },
            { link: '/api/server/store', text: 'Store' },
            { link: '/api/server/store/memory', text: 'Store.memory' },
            { link: '/api/server/store/env', text: 'Store.env' },
            { link: '/api/server/store/http', text: 'Store.http' },
            { link: '/api/server/store/kv', text: 'Store.kv' },
            { link: '/api/server/store/from', text: 'Store.from' },
          ],
          text: 'vexla/server',
        },
        { items: [{ link: '/api/node', text: 'Request' }], text: 'vexla/node' },
        { items: [{ link: '/api/hono', text: 'middleware' }], text: 'vexla/hono' },
        { items: [{ link: '/api/react', text: 'useFlag' }], text: 'vexla/react' },
        { items: [{ link: '/api/vite', text: 'vexla' }], text: 'vexla/vite' },
        { items: [{ link: '/api/vitest', text: 'create' }], text: 'vexla/vitest' },
        { items: [{ link: '/api/zile', text: 'transform' }], text: 'vexla/zile' },
      ],
      text: 'API Reference',
    },
    {
      items: [
        { link: '/cli', text: 'Overview' },
        {
          items: [
            { link: '/cli/check', text: 'check' },
            { link: '/cli/define', text: 'define' },
            { link: '/cli/dev', text: 'dev' },
            { link: '/cli/generate', text: 'generate' },
            { link: '/cli/get', text: 'get' },
            { link: '/cli/link', text: 'link' },
            { link: '/cli/list', text: 'list' },
            { link: '/cli/prune', text: 'prune' },
            { link: '/cli/retire', text: 'retire' },
            { link: '/cli/set', text: 'set' },
            { link: '/cli/stale', text: 'stale' },
            { link: '/cli/undefine', text: 'undefine' },
            { link: '/cli/unset', text: 'unset' },
          ],
          text: 'Commands',
        },
      ],
      text: 'CLI Reference',
    },
  ],
  socials: [{ icon: 'github', link: 'https://github.com/wevm/vexla' }],
  title: 'Vexla',
  topNav: [
    { link: '/introduction/getting-started', match: '/introduction', text: 'Docs' },
    { link: '/guides/flags-file', match: '/guides', text: 'Guides' },
    { link: '/api/core', match: '/api', text: 'API' },
    { link: '/cli', match: '/cli', text: 'CLI' },
  ],
})
