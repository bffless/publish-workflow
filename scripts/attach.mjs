#!/usr/bin/env node
/**
 * Attach the implementation's rule set to the harness alias.
 *
 * The harness (the `workflow` alias) serves the shell; every implementation's /api/<alias>/
 * routes and its /w/<alias>/* forwarder must resolve on that SAME origin, so the harness
 * alias carries an ORDERED UNION of every implementation's rule set. This step adds one
 * set to that union, idempotently — publishing the same implementation twice is a no-op.
 *
 * CE contract (apps/backend/src/repo-browser/repo-browser.controller.ts):
 *   GET   /api/repo/:owner/:repo/aliases              → { repository, aliases: [AliasDetailDto] }
 *   PATCH /api/repo/:owner/:repo/aliases/:aliasName   ← { proxyRuleSetIds: string[] }
 * AliasDetailDto names the alias `name` and carries both `proxyRuleSetIds` (the join
 * table, ordered) and the legacy scalar `proxyRuleSetId`.
 */
import { pathToFileURL } from 'node:url'

/** Append `id` unless it is already present; order is the harness's rule precedence. */
export function unionIds(existing, id) {
  const ids = Array.isArray(existing) ? [...existing] : []
  if (!ids.includes(id)) ids.push(id)
  return ids
}

function splitIds(ruleSetId) {
  const ids = String(ruleSetId ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (ids.length === 0) throw new Error('rule-set-id is required (comma-separated ids are allowed)')
  return ids
}

function splitRepository(repository) {
  const parts = String(repository ?? '').split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`repository "${repository}" is not owner/name`)
  }
  return parts
}

async function request(fetchImpl, url, init) {
  const res = await fetchImpl(url, init)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${init?.method ?? 'GET'} ${url} failed: ${res.status} ${res.statusText} ${body}`.trim())
  }
  return res
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

  const alias = (list?.aliases ?? []).find((a) => a?.name === harnessAlias)
  if (!alias) {
    const known = (list?.aliases ?? []).map((a) => a?.name).join(', ') || '(none)'
    throw new Error(
      `harness alias "${harnessAlias}" not found on ${repository} — known aliases: ${known}. ` +
        'Create it (the harness deploy owns it) before publishing an implementation.',
    )
  }

  // The join table is authoritative; fall back to the legacy scalar for a pre-0.2.0 row.
  const before =
    Array.isArray(alias.proxyRuleSetIds) && alias.proxyRuleSetIds.length > 0
      ? alias.proxyRuleSetIds
      : alias.proxyRuleSetId
        ? [alias.proxyRuleSetId]
        : []

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

/** Minimal `--flag value` parser — no deps, no clever aliasing. */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`)
    const value = argv[++i]
    if (value === undefined) throw new Error(`${a} needs a value`)
    out[a.slice(2)] = value
  }
  return out
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`publish-workflow: ${e.message}`)
    process.exitCode = 1
  })
}
