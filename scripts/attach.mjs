#!/usr/bin/env node
/**
 * Attach the implementation's rule set to the harness alias.
 *
 * The harness (the `workflow` alias) serves the shell; every implementation's /api/<alias>/
 * routes and its /w/<alias>/* forwarder must resolve on that SAME origin, so the harness
 * alias carries an ORDERED UNION of every implementation's rule set. This step adds one
 * set to that union, idempotently — publishing the same implementation twice is a no-op.
 *
 * See scripts/lib.mjs for the CE contract this and scripts/teardown.mjs share.
 */
import { findAliasOrThrow, isMainModule, parseArgs, request, ruleSetIdsOf, splitRepository, unionIds } from './lib.mjs'

export { unionIds }

function splitIds(ruleSetId) {
  const ids = String(ruleSetId ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (ids.length === 0) throw new Error('rule-set-id is required (comma-separated ids are allowed)')
  return ids
}

/**
 * @param {{ apiUrl: string, apiKey: string, repository: string, harnessAlias: string,
 *           ruleSetId: string, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<{ changed: boolean, proxyRuleSetIds: string[] }>}
 */
export async function attach({ apiUrl, apiKey, repository, harnessAlias, ruleSetId, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('an api key is required (X-API-Key)')
  if (!harnessAlias) throw new Error('harness-alias is required')
  const [owner, repo] = splitRepository(repository)
  const newIds = splitIds(ruleSetId)
  const base = String(apiUrl ?? '').replace(/\/+$/, '')
  const headers = { 'X-API-Key': apiKey, Accept: 'application/json' }

  const listUrl = `${base}/api/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/aliases`
  const listRes = await request(fetchImpl, listUrl, { method: 'GET', headers })
  const list = await listRes.json()

  const alias = findAliasOrThrow(
    list?.aliases,
    harnessAlias,
    repository,
    'Create it (the harness deploy owns it) before publishing an implementation.',
  )

  // The join table is authoritative; fall back to the legacy scalar for a pre-0.2.0 row.
  const before = ruleSetIdsOf(alias)

  const proxyRuleSetIds = newIds.reduce((acc, id) => unionIds(acc, id), before)
  if (proxyRuleSetIds.length === before.length) {
    return { changed: false, proxyRuleSetIds }
  }

  const patchUrl = `${listUrl}/${encodeURIComponent(harnessAlias)}`
  await request(fetchImpl, patchUrl, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ proxyRuleSetIds }),
  })
  return { changed: true, proxyRuleSetIds }
}

export async function main(argv, env = process.env, out = console.log) {
  const args = parseArgs(argv)
  const result = await attach({
    apiUrl: args['api-url'],
    // Never an argv flag: an api key on the command line lands in the runner's process list.
    apiKey: env.BFFLESS_API_KEY,
    repository: args.repository,
    harnessAlias: args['harness-alias'],
    ruleSetId: args['rule-set-id'],
  })
  out(
    result.changed
      ? `attached to "${args['harness-alias']}" → ${result.proxyRuleSetIds.length} rule set(s)`
      : `"${args['harness-alias']}" already carries the rule set — nothing to do`,
  )
  return result
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`publish-workflow: ${e.message}`)
    process.exitCode = 1
  })
}
