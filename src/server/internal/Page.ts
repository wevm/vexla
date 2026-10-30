/**
 * @module The dev route page: one HTML document with inline styles and script, which reads the
 * manifest and writes overrides, store values, and links through the admin API.
 */
import * as Json from '../../internal/Json.js'

/** Returns the HTML of the dev route page. */
export function html(options: html.Options): string {
  const config = Json.safe({ path: options.path, write: options.write })

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flags</title>
<style>
:root { color-scheme: light dark; --bg: #fff; --fg: #000; --muted: #666; --line: #ddd; --accent: #000; }
@media (prefers-color-scheme: dark) { :root { --bg: #0a0a0a; --fg: #fafafa; --muted: #999; --line: #262626; --accent: #fafafa; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
main { max-width: 960px; margin: 0 auto; padding: 32px 16px; }
h1 { font-size: 18px; margin: 0 0 4px; }
p { color: var(--muted); margin: 0 0 24px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: normal; }
.key { font-weight: bold; }
.description, .meta { color: var(--muted); font-size: 12px; }
.stale { color: #c00; }
select, input, button { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 0; padding: 4px 8px; }
button { cursor: pointer; }
button:hover { border-color: var(--accent); }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
form { margin-top: 32px; display: grid; gap: 8px; max-width: 480px; }
#status { min-height: 1.5em; margin-top: 16px; color: var(--muted); }
@media (max-width: 640px) { th:nth-child(3), td:nth-child(3) { display: none; } }
</style>
</head>
<body>
<main>
<h1>Flags</h1>
<p>Personal overrides apply to this browser only. Store values apply to every request.</p>
<table>
<thead><tr><th>Flag</th><th>Value</th><th>Source</th><th>Override</th></tr></thead>
<tbody id="flags"></tbody>
</table>
<div id="status" role="status"></div>
<form id="define" hidden>
<strong>New flag</strong>
<input name="key" placeholder="key, such as newCheckout" required>
<select name="type"><option>boolean</option><option>string</option><option>number</option><option>select</option><option>json</option></select>
<input name="default" placeholder="default, as JSON (false, &quot;a&quot;, 3)" required>
<input name="options" placeholder="options, comma separated (select only)">
<label class="row"><input type="checkbox" name="public"> public</label>
<button>Create</button>
</form>
</main>
<script type="application/json" id="config">${config}</script>
<script>
(() => {
  const config = JSON.parse(document.getElementById('config').textContent)
  const tbody = document.getElementById('flags')
  const status = document.getElementById('status')
  let manifest

  const request = async (method, path, body) => {
    const response = await fetch(config.path + path, {
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      method,
    })
    const json = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(json.error || String(response.status))
    return json
  }

  const say = (text) => { status.textContent = text }

  const overrides = () => Object.fromEntries(
    Object.entries(manifest.flags).filter((entry) => entry[1].override !== null).map((entry) => [entry[0], entry[1].override]),
  )

  const element = (tag, props, children) => {
    const node = Object.assign(document.createElement(tag), props || {})
    for (const child of children || []) node.append(child)
    return node
  }

  const control = (flag, value, onChange) => {
    if (flag.type === 'boolean') {
      const input = element('input', { checked: value === true, type: 'checkbox' })
      input.addEventListener('change', () => onChange(input.checked))
      return input
    }
    if (flag.type === 'select') {
      const select = element('select', {}, flag.options.map((option) => element('option', { selected: option === value, textContent: option, value: option })))
      select.addEventListener('change', () => onChange(select.value))
      return select
    }
    const input = element('input', { value: flag.type === 'string' ? String(value) : JSON.stringify(value) })
    input.addEventListener('change', () => {
      try { onChange(flag.type === 'string' ? input.value : JSON.parse(input.value)) } catch { say('Invalid JSON.') }
    })
    return input
  }

  const render = () => {
    tbody.replaceChildren()
    for (const [key, flag] of Object.entries(manifest.flags)) {
      const name = element('td', {}, [
        element('div', { className: 'key', textContent: key }),
        element('div', { className: 'meta', textContent: flag.env + (flag.public ? ' · public' : ' · private') + (flag.build ? ' · build' : '') }),
        ...(flag.description ? [element('div', { className: 'description', textContent: flag.description })] : []),
        ...(flag.stale ? [element('div', { className: 'stale', textContent: 'expired ' + flag.expires })] : []),
      ])

      const actions = element('div', { className: 'row' }, [
        control(flag, flag.override ?? flag.value, async (value) => {
          try {
            await request('PUT', '/overrides', { values: { ...overrides(), [key]: value } })
            await load()
            say('Override set for ' + key + '.')
          } catch (error) { say('Override failed: ' + error.message) }
        }),
      ])

      if (flag.override !== null)
        actions.append(button('Clear', async () => {
          const next = overrides()
          delete next[key]
          await request('PUT', '/overrides', { values: next })
          await load()
        }))

      if (config.write && manifest.store && !flag.build) {
        actions.append(button('Set for everyone', async () => {
          const value = flag.override ?? flag.value
          await request('PUT', '/values/' + encodeURIComponent(key), { value })
          await load()
          say('Store value set for ' + key + '.')
        }))
        if (flag.store !== null) actions.append(button('Unset', async () => {
          await request('DELETE', '/values/' + encodeURIComponent(key))
          await load()
        }))
      }

      if (config.write && !flag.build)
        actions.append(button('Share', async () => {
          const value = flag.override ?? flag.value
          const result = await request('POST', '/links', { expiresAt: Date.now() + 7 * 86400000, url: '/', values: { [key]: value } })
          await navigator.clipboard?.writeText(result.url).catch(() => {})
          say('Link copied: ' + result.url)
        }))

      tbody.append(element('tr', {}, [
        name,
        element('td', { textContent: JSON.stringify(flag.value) }),
        element('td', { textContent: flag.source }),
        element('td', {}, [actions]),
      ]))
    }
  }

  const button = (text, onClick) => {
    const node = element('button', { textContent: text, type: 'button' })
    node.addEventListener('click', () => onClick().catch((error) => say(text + ' failed: ' + error.message)))
    return node
  }

  const load = async () => {
    manifest = await request('GET', '/manifest')
    render()
    document.getElementById('define').hidden = !(config.write && manifest.storeDefinitions)
  }

  document.getElementById('define').addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(event.target)
    try {
      const definition = { default: JSON.parse(String(data.get('default'))), public: data.get('public') === 'on', type: data.get('type') }
      if (definition.type === 'select') definition.options = String(data.get('options')).split(',').map((option) => option.trim()).filter(Boolean)
      await request('PUT', '/definitions/' + encodeURIComponent(String(data.get('key'))), definition)
      event.target.reset()
      await load()
      say('Flag created.')
    } catch (error) { say('Create failed: ' + error.message) }
  })

  load().catch((error) => say('Load failed: ' + error.message))
})()
</script>
</body>
</html>`
}

export declare namespace html {
  type Options = {
    /** The path of the dev route and the admin API. */
    path: string
    /** `true` when the request has `write` access. */
    write: boolean
  }
}
