#!/usr/bin/env node
/**
 * Tear down a preview implementation: the inverse of `attach.mjs`, plus deleting the
 * preview's own alias and rule set.
 *
 * The ids to delete are the UNION of two sources, each name-verified before deletion:
 *   - the preview alias's own `proxyRuleSetIds` (the common case — publish attached one
 *     set there), and
 *   - every id currently on the HARNESS alias's `proxyRuleSetIds` that turns out to be
 *     named `<alias>` — a recovery sweep. A prior teardown can fail between deleting the
 *     alias and deleting its rule set (or someone can delete the alias by hand), which
 *     would otherwise strand an orphaned `<alias>` set on the harness forever: with the
 *     preview alias gone, its `proxyRuleSetIds` can no longer be read to find that set.
 *     CE has no project-scoped "rule sets by name" route reachable without a projectId
 *     (and no `/api/projects/:owner/:name` route either), so the harness alias's own
 *     union is the only index available — hence sweeping it here.
 * Each id is verify-GETted at most once even if it appears in both sources (the common
 * case, since publish put it in both places).
 *
 * Order, each step tolerating "already gone" so a re-run (including one that resumes a
 * partial prior failure) finishes the cleanup rather than erroring:
 *   1. GET the harness project's aliases; find the HARNESS alias (throw if missing — see
 *      below) and the PREVIEW alias (tolerated if missing).
 *   2. Verify-GET every candidate id (from both sources above); refuse if a PREVIEW-owned
 *      id turns out not to be named `<alias>` (never delete a set that doesn't belong to
 *      this preview); silently drop a harness-swept id that isn't (it belongs to some
 *      other implementation).
 *   3. PATCH the harness alias with its `proxyRuleSetIds` MINUS every verified id (no
 *      write when nothing changes).
 *   4. DELETE the preview alias, if it still exists (`DELETE .../aliases/:name` → 204;
 *      404 tolerated).
 *   5. DELETE every verified id (404 tolerated; a 409 — the project's default rule set —
 *      is a hard error rather than tolerated).
 *
 * A missing HARNESS alias is a hard error (mirrors `attach.mjs`): a typo'd
 * `harness-alias` must not silently no-op a teardown that looks like it succeeded.
 *
 * Refuses to run at all unless `alias` looks like a preview alias
 * (`^[a-z][a-z0-9-]*-pr-[0-9]+$`) or `preview: true` is passed: the contributor-role key
 * can repoint any alias on the harness project, and a typo must not tear down production.
 */
import {
  findAliasOrThrow,
  isMainModule,
  parseArgs,
  request,
  requestTolerant404,
  ruleSetIdsOf,
  splitRepository,
  withoutIds,
} from './lib.mjs'

export { withoutIds }

const PREVIEW_ALIAS_RE = /^[a-z][a-z0-9-]*-pr-[0-9]+$/

function assertPreviewOrOptIn(alias, preview) {
  if (preview) return
  if (PREVIEW_ALIAS_RE.test(String(alias ?? ''))) return
  throw new Error(
    `alias "${alias}" does not look like a preview alias (expected ${PREVIEW_ALIAS_RE}); ` +
      'pass preview: true to tear down a non-preview alias anyway.',
  )
}

/**
 * @param {{ apiUrl: string, apiKey: string, repository: string, harnessAlias: string,
 *           alias: string, preview?: boolean, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<{ detached: boolean, deletedAlias: boolean, deletedRuleSet: boolean }>}
 */
export async function teardown({
  apiUrl,
  apiKey,
  repository,
  harnessAlias,
  alias,
  preview = false,
  fetchImpl = fetch,
}) {
  assertPreviewOrOptIn(alias, preview)
  if (!apiKey) throw new Error('an api key is required (X-API-Key)')
  if (!harnessAlias) throw new Error('harness-alias is required')
  const [owner, repo] = splitRepository(repository)
  const base = String(apiUrl ?? '').replace(/\/+$/, '')
  const headers = { 'X-API-Key': apiKey, Accept: 'application/json' }

  const listUrl = `${base}/api/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/aliases`
  const listRes = await request(fetchImpl, listUrl, { method: 'GET', headers })
  const list = await listRes.json()
  const aliases = list?.aliases ?? []

  const harness = findAliasOrThrow(
    aliases,
    harnessAlias,
    repository,
    'Create it (the harness deploy owns it) before tearing down a preview.',
  )
  const previewAlias = aliases.find((a) => a?.name === alias)
  const before = ruleSetIdsOf(harness)
  const previewIds = ruleSetIdsOf(previewAlias)

  // Verify-GET each candidate id at most once.
  const cache = new Map() // id -> { name, ... } | null (null = already gone)
  const verify = async (id) => {
    if (cache.has(id)) return cache.get(id)
    const setUrl = `${base}/api/proxy-rule-sets/${encodeURIComponent(id)}`
    const { res, gone } = await requestTolerant404(fetchImpl, setUrl, { method: 'GET', headers })
    const entry = gone ? null : await res.json()
    cache.set(id, entry)
    return entry
  }

  const idsToDelete = new Set()
  for (const id of previewIds) {
    const set = await verify(id)
    if (set === null) continue // already gone
    if (set.name !== alias) {
      throw new Error(
        `refusing to delete rule set ${id}: named "${set.name}", not "${alias}" — it does not belong to this preview`,
      )
    }
    idsToDelete.add(id)
  }
  for (const id of before) {
    const set = await verify(id)
    if (set !== null && set.name === alias) idsToDelete.add(id)
  }

  // 1. Detach every id-to-delete from the harness union.
  const after = before.filter((id) => !idsToDelete.has(id))
  let detached = false
  if (after.length !== before.length) {
    await request(fetchImpl, `${listUrl}/${encodeURIComponent(harnessAlias)}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxyRuleSetIds: after }),
    })
    detached = true
  }

  // 2. Delete the preview alias, if it still exists.
  let deletedAlias = false
  if (previewAlias) {
    const { gone } = await requestTolerant404(fetchImpl, `${listUrl}/${encodeURIComponent(alias)}`, {
      method: 'DELETE',
      headers,
    })
    deletedAlias = !gone
  }

  // 3. Delete every verified rule set.
  let deletedRuleSet = false
  for (const id of idsToDelete) {
    const setUrl = `${base}/api/proxy-rule-sets/${encodeURIComponent(id)}`
    const { gone } = await requestTolerant404(fetchImpl, setUrl, { method: 'DELETE', headers })
    if (!gone) deletedRuleSet = true
  }

  return { detached, deletedAlias, deletedRuleSet }
}

export async function main(argv, env = process.env, out = console.log) {
  const args = parseArgs(argv)
  const result = await teardown({
    apiUrl: args['api-url'],
    // Never an argv flag: an api key on the command line lands in the runner's process list.
    apiKey: env.BFFLESS_API_KEY,
    repository: args.repository,
    harnessAlias: args['harness-alias'],
    alias: args.alias,
    preview: args.preview === 'true',
  })
  // Redirected straight into $GITHUB_OUTPUT by the composite step — see prepare-rules.mjs's
  // `dir=` line for the same pattern. Nothing else may go to stdout here.
  out(`detached=${result.detached}`)
  out(`deleted-alias=${result.deletedAlias}`)
  out(`deleted-rule-set=${result.deletedRuleSet}`)
  return result
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`publish-workflow: ${e.message}`)
    process.exitCode = 1
  })
}
