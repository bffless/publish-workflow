#!/usr/bin/env node
/**
 * Tear down a preview implementation: the inverse of `attach.mjs`, plus deleting the
 * preview's own alias and rule set.
 *
 * Order, each step tolerating "already gone" so a re-run is a no-op:
 *   1. GET the harness project's aliases and find the PREVIEW alias (named `<alias>`).
 *      Not found → nothing to do, resolve without any write.
 *   2. PATCH the harness alias with its `proxyRuleSetIds` MINUS every id the preview
 *      alias carries (no write when none of them were present — mirrors `attach.mjs`'s
 *      PATCH-free no-op).
 *   3. DELETE the preview alias (`DELETE /api/repo/:owner/:repo/aliases/:name` → 204;
 *      404 tolerated).
 *   4. For every id the preview alias carried: GET `/api/proxy-rule-sets/:id` to confirm
 *      its `name` is `<alias>` — refuse otherwise, never delete a set that merely shares
 *      an id with this alias in a stale aliases list — then DELETE it (404 tolerated; a
 *      409, the project's default rule set, is a hard error rather than tolerated).
 *
 * CE contract (apps/backend/src/repo-browser/repo-browser.controller.ts,
 * apps/backend/src/proxy-rules/proxy-rule-sets.controller.ts):
 *   GET    /api/repo/:owner/:repo/aliases              → { repository, aliases: [AliasDetailDto] }
 *   PATCH  /api/repo/:owner/:repo/aliases/:aliasName   ← { proxyRuleSetIds: string[] }
 *   DELETE /api/repo/:owner/:repo/aliases/:aliasName   → 204; 404 when absent
 *   GET    /api/proxy-rule-sets/:id                    → { name, ... }; 404 when absent
 *   DELETE /api/proxy-rule-sets/:id                    → 200 { success: true }; 404 when
 *                                                          absent; 409 when it is the
 *                                                          project's default rule set
 *
 * Refuses to run at all unless `alias` looks like a preview alias
 * (`^[a-z][a-z0-9-]*-pr-[0-9]+$`) or `preview: true` is passed: the contributor-role key
 * can repoint any alias on the harness project, and a typo must not tear down production.
 */
import { pathToFileURL } from 'node:url'

const PREVIEW_ALIAS_RE = /^[a-z][a-z0-9-]*-pr-[0-9]+$/

/** Remove `id` if present; order of the remainder is preserved. Inverse of `unionIds`. */
export function withoutIds(existing, id) {
  const ids = Array.isArray(existing) ? [...existing] : []
  return ids.filter((x) => x !== id)
}

/** The join table is authoritative; fall back to the legacy scalar for a pre-0.2.0 row. */
function idsOf(alias) {
  if (!alias) return []
  if (Array.isArray(alias.proxyRuleSetIds) && alias.proxyRuleSetIds.length > 0) return alias.proxyRuleSetIds
  return alias.proxyRuleSetId ? [alias.proxyRuleSetId] : []
}

function splitRepository(repository) {
  const parts = String(repository ?? '').split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`repository "${repository}" is not owner/name`)
  }
  return parts
}

function assertPreviewOrOptIn(alias, preview) {
  if (preview) return
  if (PREVIEW_ALIAS_RE.test(String(alias ?? ''))) return
  throw new Error(
    `alias "${alias}" does not look like a preview alias (expected ${PREVIEW_ALIAS_RE}); ` +
      'pass preview: true to tear down a non-preview alias anyway.',
  )
}

async function request(fetchImpl, url, init) {
  const res = await fetchImpl(url, init)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${init?.method ?? 'GET'} ${url} failed: ${res.status} ${res.statusText} ${body}`.trim())
  }
  return res
}

/** Like `request`, but a 404 means "already gone" rather than an error. */
async function requestTolerant404(fetchImpl, url, init) {
  const res = await fetchImpl(url, init)
  if (res.status === 404) return { res, gone: true }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${init?.method ?? 'GET'} ${url} failed: ${res.status} ${res.statusText} ${body}`.trim())
  }
  return { res, gone: false }
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

  const previewAlias = aliases.find((a) => a?.name === alias)
  if (!previewAlias) {
    // Already gone (or never existed) — a re-run of this action must not error.
    return { detached: false, deletedAlias: false, deletedRuleSet: false }
  }
  const idsToRemove = idsOf(previewAlias)

  // 1. Detach every id the preview owns from the harness union.
  const harness = aliases.find((a) => a?.name === harnessAlias)
  const before = idsOf(harness)
  const after = idsToRemove.reduce((acc, id) => withoutIds(acc, id), before)
  let detached = false
  if (after.length !== before.length) {
    await request(fetchImpl, `${listUrl}/${encodeURIComponent(harnessAlias)}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxyRuleSetIds: after }),
    })
    detached = true
  }

  // 2. Delete the preview alias.
  const { gone: aliasGone } = await requestTolerant404(fetchImpl, `${listUrl}/${encodeURIComponent(alias)}`, {
    method: 'DELETE',
    headers,
  })
  const deletedAlias = !aliasGone

  // 3. Delete every rule set the preview alias carried, after confirming each one is
  //    actually named `<alias>` — the aliases list can be stale, and an id must never
  //    be trusted blind.
  let deletedRuleSet = false
  for (const id of idsToRemove) {
    const setUrl = `${base}/api/proxy-rule-sets/${encodeURIComponent(id)}`
    const { res: getRes, gone: setGone } = await requestTolerant404(fetchImpl, setUrl, { method: 'GET', headers })
    if (setGone) continue
    const set = await getRes.json()
    if (set?.name !== alias) {
      throw new Error(
        `refusing to delete rule set ${id}: named "${set?.name}", not "${alias}" — it does not belong to this preview`,
      )
    }
    const { gone: deleteGone } = await requestTolerant404(fetchImpl, setUrl, { method: 'DELETE', headers })
    if (!deleteGone) deletedRuleSet = true
  }

  return { detached, deletedAlias, deletedRuleSet }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`publish-workflow: ${e.message}`)
    process.exitCode = 1
  })
}
