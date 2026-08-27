import { test } from 'node:test'
import assert from 'node:assert/strict'

import { unionIds, attach } from '../scripts/attach.mjs'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A CE stub: GET .../aliases lists, PATCH .../aliases/<name> accepts. */
function stub(aliases, { patchStatus = 200, patchBody = {} } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push([url, init?.method ?? 'GET', init?.body, init?.headers])
    if ((init?.method ?? 'GET') === 'GET') return json({ repository: 'o/n', aliases })
    return json(patchBody, patchStatus)
  }
  return { calls, fetchImpl }
}

test('unionIds appends once, in order', () => {
  assert.deepEqual(unionIds(['a', 'b'], 'b'), ['a', 'b'])
  assert.deepEqual(unionIds(['a'], 'c'), ['a', 'c'])
  assert.deepEqual(unionIds([], 'c'), ['c'])
  assert.deepEqual(unionIds(undefined, 'c'), ['c'])
})

test('attach GETs the repo aliases then PATCHes the union', async () => {
  const { calls, fetchImpl } = stub([{ name: 'workflow', proxyRuleSetIds: ['a'] }])
  await attach({
    apiUrl: 'https://x',
    apiKey: 'k',
    repository: 'o/n',
    harnessAlias: 'workflow',
    ruleSetId: 'b',
    fetchImpl,
  })
  assert.equal(calls[0][0], 'https://x/api/repo/o/n/aliases')
  assert.equal(calls[0][1], 'GET')
  assert.equal(calls[0][3]['X-API-Key'], 'k')
  assert.equal(calls[1][0], 'https://x/api/repo/o/n/aliases/workflow')
  assert.equal(calls[1][1], 'PATCH')
  assert.deepEqual(JSON.parse(calls[1][2]), { proxyRuleSetIds: ['a', 'b'] })
})

test('attach unions every id in a comma-separated list', async () => {
  const { calls, fetchImpl } = stub([{ name: 'workflow', proxyRuleSetIds: ['a'] }])
  await attach({
    apiUrl: 'https://x/',
    apiKey: 'k',
    repository: 'o/n',
    harnessAlias: 'workflow',
    ruleSetId: ' b , a ,c ',
    fetchImpl,
  })
  assert.deepEqual(JSON.parse(calls[1][2]), { proxyRuleSetIds: ['a', 'b', 'c'] })
})

test('attach falls back to the legacy single proxyRuleSetId', async () => {
  const { calls, fetchImpl } = stub([{ name: 'workflow', proxyRuleSetId: 'a' }])
  await attach({ apiUrl: 'https://x', apiKey: 'k', repository: 'o/n', harnessAlias: 'workflow', ruleSetId: 'b', fetchImpl })
  assert.deepEqual(JSON.parse(calls[1][2]), { proxyRuleSetIds: ['a', 'b'] })
})

test('attach is a no-op PATCH-free when the set is already attached', async () => {
  const { calls, fetchImpl } = stub([{ name: 'workflow', proxyRuleSetIds: ['a', 'b'] }])
  const result = await attach({
    apiUrl: 'https://x',
    apiKey: 'k',
    repository: 'o/n',
    harnessAlias: 'workflow',
    ruleSetId: 'b',
    fetchImpl,
  })
  assert.equal(calls.length, 1)
  assert.equal(result.changed, false)
  assert.deepEqual(result.proxyRuleSetIds, ['a', 'b'])
})

test('attach fails when the harness alias does not exist', async () => {
  const { fetchImpl } = stub([{ name: 'production', proxyRuleSetIds: [] }])
  await assert.rejects(
    attach({ apiUrl: 'https://x', apiKey: 'k', repository: 'o/n', harnessAlias: 'workflow', ruleSetId: 'b', fetchImpl }),
    /harness alias "workflow" not found/,
  )
})

test('attach throws with the status and body on a non-2xx', async () => {
  const fetchImpl = async () => new Response('nope', { status: 403 })
  await assert.rejects(
    attach({ apiUrl: 'https://x', apiKey: 'k', repository: 'o/n', harnessAlias: 'workflow', ruleSetId: 'b', fetchImpl }),
    /403.*nope/s,
  )
})

test('attach rejects a repository that is not owner/name', async () => {
  const { fetchImpl } = stub([])
  await assert.rejects(
    attach({ apiUrl: 'https://x', apiKey: 'k', repository: 'justname', harnessAlias: 'workflow', ruleSetId: 'b', fetchImpl }),
    /owner\/name/,
  )
})

test('attach requires an api key', async () => {
  const { fetchImpl } = stub([])
  await assert.rejects(
    attach({ apiUrl: 'https://x', apiKey: '', repository: 'o/n', harnessAlias: 'workflow', ruleSetId: 'b', fetchImpl }),
    /api key/i,
  )
})
