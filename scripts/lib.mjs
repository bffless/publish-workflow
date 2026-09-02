/**
 * Shared plumbing for the publish-workflow scripts: CE's repo-aliases contract, the tiny
 * argv parser, and the "run only when invoked directly" guard. Kept dependency-free — no
 * build step needed, just like the script that uses it.
 *
 * As of v2 that script is teardown.mjs alone — the publish path is `npx @bffless/workflow
 * publish`, which carries its own port of what attach.mjs and prepare-rules.mjs used to do.
 * This module stays separate rather than folding into teardown.mjs because the CE contract
 * below is worth stating in one place, independent of the one caller that reads it today.
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
 * AliasDetailDto names the alias `name` and carries both `proxyRuleSetIds` (the join
 * table, ordered) and the legacy scalar `proxyRuleSetId`.
 */
import { pathToFileURL } from 'node:url'

/** `owner/name` → [owner, name]; throws otherwise. */
export function splitRepository(repository) {
  const parts = String(repository ?? '').split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`repository "${repository}" is not owner/name`)
  }
  return parts
}

/** Minimal `--flag value` parser — no deps, no clever aliasing. */
export function parseArgs(argv) {
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

/** Throws with the status + body on a non-2xx response; otherwise returns it. */
export async function request(fetchImpl, url, init) {
  const res = await fetchImpl(url, init)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${init?.method ?? 'GET'} ${url} failed: ${res.status} ${res.statusText} ${body}`.trim())
  }
  return res
}

/** Like `request`, but a 404 means "already gone" rather than an error. */
export async function requestTolerant404(fetchImpl, url, init) {
  const res = await fetchImpl(url, init)
  if (res.status === 404) return { res, gone: true }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${init?.method ?? 'GET'} ${url} failed: ${res.status} ${res.statusText} ${body}`.trim())
  }
  return { res, gone: false }
}

/** Find `name` among `aliases`, or throw naming what's actually there. */
export function findAliasOrThrow(aliases, name, repository, hint) {
  const alias = (aliases ?? []).find((a) => a?.name === name)
  if (alias) return alias
  const known = (aliases ?? []).map((a) => a?.name).join(', ') || '(none)'
  throw new Error(`harness alias "${name}" not found on ${repository} — known aliases: ${known}. ${hint}`)
}

/** The join table is authoritative; fall back to the legacy scalar for a pre-0.2.0 row. */
export function ruleSetIdsOf(alias) {
  if (!alias) return []
  if (Array.isArray(alias.proxyRuleSetIds) && alias.proxyRuleSetIds.length > 0) return alias.proxyRuleSetIds
  return alias.proxyRuleSetId ? [alias.proxyRuleSetId] : []
}

/**
 * Remove `id` if present; order of the remainder is preserved. The inverse of the union
 * publish performs — which now lives in `@bffless/workflow`'s `attachToHarness`, ported
 * from the attach.mjs this repo carried through v1.
 */
export function withoutIds(existing, id) {
  const ids = Array.isArray(existing) ? [...existing] : []
  return ids.filter((x) => x !== id)
}

/** True when this module was invoked directly (`node scripts/x.mjs`), not imported. */
export function isMainModule(metaUrl, argv1 = process.argv[1]) {
  return Boolean(argv1) && metaUrl === pathToFileURL(argv1).href
}
