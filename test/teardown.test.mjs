import { test } from 'node:test'
import assert from 'node:assert/strict'

import { withoutIds, teardown } from '../scripts/teardown.mjs'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * A CE stub covering every request `teardown` can make:
 *   GET    .../aliases                  → { repository, aliases }
 *   PATCH  .../aliases/<harnessAlias>
 *   DELETE .../aliases/<alias>          → deleteAliasStatus (default 204)
 *   GET    .../proxy-rule-sets/<id>     → ruleSets[id], or 404 if absent
 *   DELETE .../proxy-rule-sets/<id>     → deleteSetStatus (default 200)
 */
function stub({ aliases, ruleSets = {}, patchStatus = 200, deleteAliasStatus = 204, deleteSetStatus = 200 } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const method = init?.method ?? 'GET'
    calls.push([url, method, init?.body, init?.headers])
    if (method === 'GET' && url.endsWith('/aliases')) return json({ repository: 'o/n', aliases })
    if (method === 'PATCH') return json({}, patchStatus)
    if (method === 'DELETE' && url.includes('/aliases/')) return new Response(null, { status: deleteAliasStatus })
    if (method === 'GET' && url.includes('/proxy-rule-sets/')) {
      const id = url.split('/').pop()
      if (!(id in ruleSets)) return new Response('not found', { status: 404 })
      return json(ruleSets[id])
    }
    if (method === 'DELETE' && url.includes('/proxy-rule-sets/')) return json({ success: true }, deleteSetStatus)
    throw new Error(`unexpected request: ${method} ${url}`)
  }
  return { calls, fetchImpl }
}

test('withoutIds removes an id once; no-op when absent', () => {
  assert.deepEqual(withoutIds(['a', 'b'], 'b'), ['a'])
  assert.deepEqual(withoutIds(['a'], 'z'), ['a'])
  assert.deepEqual(withoutIds([], 'z'), [])
  assert.deepEqual(withoutIds(undefined, 'z'), [])
})

test('teardown detaches from the harness, deletes the alias, then deletes the rule set, in order', async () => {
  const { calls, fetchImpl } = stub({
    aliases: [
      { name: 'workflow', proxyRuleSetIds: ['a', 'rs1'] },
      { name: 'hello-pr-12', proxyRuleSetIds: ['rs1'] },
    ],
    ruleSets: { rs1: { id: 'rs1', name: 'hello-pr-12' } },
  })
  const result = await teardown({
    apiUrl: 'https://x',
    apiKey: 'k',
    repository: 'o/n',
    harnessAlias: 'workflow',
    alias: 'hello-pr-12',
    fetchImpl,
  })
  assert.deepEqual(result, { detached: true, deletedAlias: true, deletedRuleSet: true })

  assert.equal(calls[0][0], 'https://x/api/repo/o/n/aliases')
  assert.equal(calls[0][1], 'GET')

  assert.equal(calls[1][0], 'https://x/api/repo/o/n/aliases/workflow')
  assert.equal(calls[1][1], 'PATCH')
  assert.deepEqual(JSON.parse(calls[1][2]), { proxyRuleSetIds: ['a'] })

  assert.equal(calls[2][0], 'https://x/api/repo/o/n/aliases/hello-pr-12')
  assert.equal(calls[2][1], 'DELETE')

  assert.equal(calls[3][0], 'https://x/api/proxy-rule-sets/rs1')
  assert.equal(calls[3][1], 'GET')

  assert.equal(calls[4][0], 'https://x/api/proxy-rule-sets/rs1')
  assert.equal(calls[4][1], 'DELETE')
})

test('a second run finds no such preview alias — no writes, resolves cleanly', async () => {
  const { calls, fetchImpl } = stub({ aliases: [{ name: 'workflow', proxyRuleSetIds: ['a'] }] })
  const result = await teardown({
    apiUrl: 'https://x',
    apiKey: 'k',
    repository: 'o/n',
    harnessAlias: 'workflow',
    alias: 'hello-pr-12',
    fetchImpl,
  })
  assert.deepEqual(result, { detached: false, deletedAlias: false, deletedRuleSet: false })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], 'GET')
})

test('refuses a non-preview alias without preview: true, before any request', async () => {
  const { calls, fetchImpl } = stub({ aliases: [] })
  await assert.rejects(
    teardown({ apiUrl: 'https://x', apiKey: 'k', repository: 'o/n', harnessAlias: 'workflow', alias: 'hello', fetchImpl }),
    /preview/i,
  )
  assert.equal(calls.length, 0)
})

test('accepts a non-preview alias when preview: true is passed', async () => {
  const { calls, fetchImpl } = stub({ aliases: [] })
  const result = await teardown({
    apiUrl: 'https://x',
    apiKey: 'k',
    repository: 'o/n',
    harnessAlias: 'workflow',
    alias: 'hello',
    preview: true,
    fetchImpl,
  })
  assert.deepEqual(result, { detached: false, deletedAlias: false, deletedRuleSet: false })
  assert.equal(calls.length, 1)
})

test('refuses to delete a rule set whose name does not match the alias, before deleting it', async () => {
  const { calls, fetchImpl } = stub({
    aliases: [
      { name: 'workflow', proxyRuleSetIds: ['rs1'] },
      { name: 'hello-pr-12', proxyRuleSetIds: ['rs1'] },
    ],
    ruleSets: { rs1: { id: 'rs1', name: 'something-else' } },
  })
  await assert.rejects(
    teardown({ apiUrl: 'https://x', apiKey: 'k', repository: 'o/n', harnessAlias: 'workflow', alias: 'hello-pr-12', fetchImpl }),
    /something-else/,
  )
  const deleteSetCalls = calls.filter(([url, method]) => method === 'DELETE' && url.includes('/proxy-rule-sets/'))
  assert.equal(deleteSetCalls.length, 0)
})

test('skips the PATCH when the harness alias does not carry the id, but still deletes alias + set', async () => {
  const { calls, fetchImpl } = stub({
    aliases: [
      { name: 'workflow', proxyRuleSetIds: ['other'] },
      { name: 'hello-pr-12', proxyRuleSetIds: ['rs1'] },
    ],
    ruleSets: { rs1: { id: 'rs1', name: 'hello-pr-12' } },
  })
  const result = await teardown({
    apiUrl: 'https://x',
    apiKey: 'k',
    repository: 'o/n',
    harnessAlias: 'workflow',
    alias: 'hello-pr-12',
    fetchImpl,
  })
  assert.equal(result.detached, false)
  assert.equal(result.deletedAlias, true)
  assert.equal(result.deletedRuleSet, true)
  assert.ok(!calls.some(([, method]) => method === 'PATCH'))
})

test('tolerates the alias already being gone (404) when deleting it', async () => {
  const { fetchImpl } = stub({
    aliases: [{ name: 'hello-pr-12', proxyRuleSetIds: ['rs1'] }],
    ruleSets: { rs1: { id: 'rs1', name: 'hello-pr-12' } },
    deleteAliasStatus: 404,
  })
  const result = await teardown({
    apiUrl: 'https://x',
    apiKey: 'k',
    repository: 'o/n',
    harnessAlias: 'workflow',
    alias: 'hello-pr-12',
    fetchImpl,
  })
  assert.equal(result.deletedAlias, false)
  assert.equal(result.deletedRuleSet, true)
})

test('tolerates the rule set already being gone (404 on the verify GET)', async () => {
  const { fetchImpl } = stub({
    aliases: [{ name: 'hello-pr-12', proxyRuleSetIds: ['rs1'] }],
    ruleSets: {},
  })
  const result = await teardown({
    apiUrl: 'https://x',
    apiKey: 'k',
    repository: 'o/n',
    harnessAlias: 'workflow',
    alias: 'hello-pr-12',
    fetchImpl,
  })
  assert.equal(result.deletedRuleSet, false)
})

test('treats a 409 deleting the rule set (project default) as a hard error', async () => {
  const { fetchImpl } = stub({
    aliases: [{ name: 'hello-pr-12', proxyRuleSetIds: ['rs1'] }],
    ruleSets: { rs1: { id: 'rs1', name: 'hello-pr-12' } },
    deleteSetStatus: 409,
  })
  await assert.rejects(
    teardown({ apiUrl: 'https://x', apiKey: 'k', repository: 'o/n', harnessAlias: 'workflow', alias: 'hello-pr-12', fetchImpl }),
    /409/,
  )
})

test('teardown rejects a repository that is not owner/name', async () => {
  const { fetchImpl } = stub({ aliases: [] })
  await assert.rejects(
    teardown({ apiUrl: 'https://x', apiKey: 'k', repository: 'justname', harnessAlias: 'workflow', alias: 'hello-pr-12', fetchImpl }),
    /owner\/name/,
  )
})

test('teardown requires an api key', async () => {
  const { fetchImpl } = stub({ aliases: [] })
  await assert.rejects(
    teardown({ apiUrl: 'https://x', apiKey: '', repository: 'o/n', harnessAlias: 'workflow', alias: 'hello-pr-12', fetchImpl }),
    /api key/i,
  )
})
