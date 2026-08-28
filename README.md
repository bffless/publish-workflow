# `bffless/publish-workflow`

Publishes a **BFFless Workflow implementation**: one composite action for the five things
every implementation repo has to do identically, so no repo re-derives them.

```yaml
- uses: bffless/publish-workflow@v1
  with:
    alias: hello
    api-url: https://j5s.dev
    api-key: ${{ secrets.BFFLESS_API_KEY }}
    repository: bffless/workflow
```

## What it does

The obligations are spec'd in `apps/workflow/docs/spec/06-discovery-publishing-files.md`
("Implementation CI obligations"). In order:

1. **Build** — yours. Run it before this action; `path` (default `dist`) is what it produced.
2. **Lint + index** — `workflow index` (`@bffless/workflow-lint`) lints every YAML under
   `workflows` *against the rule set being published* and, only if all of them pass, writes
   `<path>/.bffless/workflows/` (the YAMLs plus the generated `index.json` the harness reads)
   and a landing `index.html`. **A failing lint fails the publish** — that is the point: the
   linter's `rule-missing` check holds every relative `with.path` / `poll.path` to the rule
   that will serve it, so a typo on either side is caught here instead of as a run-time 404.
   The rule set is passed with `--path-prefix /api/<alias>`, so a prefix-free source set
   resolves the way it will once live.
3. **Sync the rule set** — `bffless/deploy-proxy-rules@v1` pushes the set as **`<alias>`**
   with every *derived* rule path rewritten under `/api/<alias>/`. Before pushing, this
   action stages a copy of the set under `$RUNNER_TEMP` and (a) rewrites `ruleset.yaml`'s
   `name:` to the alias and (b) generates the **`/w/<alias>/*` forwarder**, `targetUrl:`
   resolved by the "Resolve inputs" step — the alias served in-process by the CE backend
   by default, or your `target-url` override. Your checkout is never modified.
4. **Deploy** — `bffless/upload-artifact@v1` uploads `path` to alias `<alias>` with
   `base-path: /` and attaches the `<alias>` rule set to that alias by name.
5. **Attach to the harness alias** — `PATCH /api/repo/<owner>/<repo>/aliases/<harness-alias>`
   with the **ordered union** of the harness alias' existing `proxyRuleSetIds` and this one.
   Idempotent: publishing the same implementation twice makes no *write* the second time
   (the GET always runs).

   On PR close, tear the preview down with `mode: teardown` (below) — the inverse of this
   step, plus deleting the preview's own alias and rule set.

### Why the forwarder

Everything the browser talks to must be **one origin** — the harness host (ADR-0001, D2).
Your bundle lives on its own alias host, so the harness needs a proxy rule that serves it
same-origin: `/w/<alias>/*` on the harness → your alias. This action generates that rule; the
source set must **not** contain `rules/_custom/forward` (it refuses if it does, rather than
silently overwriting a hand-authored rule).

By default the forwarder's `targetUrl` points at the alias **in-process** on the CE
backend — `<backend-url>/public/<owner>/<repo>/alias/<alias>/<path input, as given>` (a
rule without `authTransform` is never rendered into nginx; it's forwarded in-process by
the backend itself, so `http://localhost:3000` — `backend-url`'s default — is the CE
backend's own address, right for every CE install). No domain, no per-install hostname,
and it works for previews with nothing extra. Pass an explicit `target-url` to override
this and forward to a real domain instead — the legacy per-install mode, useful when you
want the implementation alias browsable on its own host.
[bffless/ce#698](https://github.com/bffless/ce/issues/698) — `targetUrl: alias://<impl>` —
remains a nice-to-have that would make the rule declarative instead of a resolved URL, not
a blocker.

**Caveat: signed-out requests through the forwarder.** If the harness project's
`unauthorizedBehavior` is `redirect_login`, a signed-out request hitting the forwarder
gets a 302 whose `Location` is derived from the backend-local request (not the harness's
public host) — surprising if you were expecting a redirect back to the harness. The
default, `not_found` (a 404), is what the harness expects and needs no special handling.

The forwarder carries an **explicit** `pathPattern:`, which `--path-prefix` never rewrites
(the CE CLI prefixes only *derived* patterns), so `/w/<alias>/*` survives the sync verbatim.

### Previews are first-class

`alias: hello-pr-12` yields `/api/hello-pr-12/...`, `/w/hello-pr-12/...`, a `hello-pr-12`
rule set on the harness alias, and a *preview* entry on the harness's Implementations screen.
The workflow YAML is byte-identical between production and preview because workflow paths are
relative (D17) and the prefix is added at publish time.

**A preview run must pass `rules:` explicitly.** The rule-set directory on disk is named for
the **implementation**, not for the alias — `.bffless/proxy-rules/hello` stays put while the
alias becomes `hello-pr-12`. The `rules` default (`.bffless/proxy-rules/<alias>`) would
resolve to a directory that does not exist, and `workflow index` treats an explicit `--rules`
that does not resolve as an error, so the publish exits 2 before anything is deployed:

```yaml
- uses: bffless/publish-workflow@v1
  with:
    alias: hello-pr-${{ github.event.number }}
    rules: .bffless/proxy-rules/hello        # named for the impl, not the alias
    api-url: https://j5s.dev
    api-key: ${{ secrets.BFFLESS_API_KEY }}
    repository: bffless/workflow
```

No `target-url` needed: the forwarder defaults to the preview alias served in-process by
the CE backend, so nothing here has to map a domain to it. A preview alias is still fully
discoverable and attached to the harness with zero domain setup. What accumulates instead,
and what `mode: teardown` (below) cleans up, are the preview alias itself, its rule set,
and the harness attachment.

### Preview teardown (`mode: teardown`)

On PR close, delete the preview alias and its rule set, and detach it from the harness
alias — the inverse of obligations 3–5 above. It needs no build, no bundle and no lint, so
none of `path`, `workflows` or `target-url` are read in this mode:

```yaml
- uses: bffless/publish-workflow@v1
  with:
    mode: teardown
    alias: hello-pr-${{ github.event.number }}
    api-url: https://j5s.dev
    api-key: ${{ secrets.BFFLESS_API_KEY }}
    repository: bffless/workflow
```

A full preview `preview.yml` (this lives in the **implementation** repo, e.g.
`bffless/workflow-hello`, not here):

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

jobs:
  preview:
    if: github.event.action != 'closed'
    runs-on: ubuntu-latest
    steps:
      # ... build the bundle into dist/ ...
      - uses: bffless/publish-workflow@v1
        with:
          alias: hello-pr-${{ github.event.number }}
          rules: .bffless/proxy-rules/hello
          api-url: https://j5s.dev
          api-key: ${{ secrets.BFFLESS_API_KEY }}
          repository: bffless/workflow

  teardown:
    if: github.event.action == 'closed'
    runs-on: ubuntu-latest
    steps:
      - uses: bffless/publish-workflow@v1
        with:
          mode: teardown
          alias: hello-pr-${{ github.event.number }}
          api-url: https://j5s.dev
          api-key: ${{ secrets.BFFLESS_API_KEY }}
          repository: bffless/workflow
```

**Idempotent, including recovery from a partial failure.** Every step tolerates "already
gone": closing the same PR twice makes no write and exits 0. If a prior run deleted the
preview alias but then failed before deleting its rule set (or a manual cleanup did the
same), the set would otherwise be stranded — its id lived only on the now-deleted alias.
Teardown also sweeps the harness alias' own `proxyRuleSetIds` for any id that turns out to
be named `<alias>`, so a re-run finds and finishes that cleanup rather than seeing nothing
to do.

**Refuses a non-preview alias.** `alias` must match `^[a-z][a-z0-9-]*-pr-[0-9]+$`, or the
step fails **before making any request** — the API key's `contributor` role can repoint or
delete any alias on the harness project, so a plain `alias: hello` (production) must not
reach teardown by accident. To tear down a non-preview alias on purpose, pass `preview: true`.

**Never deletes a rule set it didn't publish.** Before deleting anything, teardown
re-fetches every candidate rule set (the preview alias' own ids, plus — for the recovery
sweep above — every id the harness alias carries) and checks its `name` against `alias`.
A set the preview alias itself pointed at that turns out to be named something else
refuses the whole run rather than deleting it; a harness-swept id that doesn't match is
simply left alone (it belongs to some other implementation).

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `mode` | no | `publish` | `publish` (build + deploy + attach) or `teardown` (delete a preview and detach it). |
| `alias` | yes | — | The implementation alias, e.g. `hello`. `^[a-z][a-z0-9-]*$`; `workflow`, `w`, `auth` and `_bffless` are reserved. |
| `api-url` | yes | — | Base URL of the BFFless instance, e.g. `https://j5s.dev`. |
| `api-key` | yes | — | API key (`X-API-Key`). Needs a **project role** on the harness project — see below. |
| `repository` | yes | — | The **harness** project, `owner/name`. The alias and the rule set are created there. |
| `target-url` | no | — | Override the forwarder's target, e.g. `https://hello.j5s.dev` (the legacy per-domain mode). Default: the alias served in-process on `backend-url`. Unused in teardown mode. |
| `backend-url` | no | `http://localhost:3000` | The CE backend's own address, as reachable from the backend itself (the forwarder is proxied in-process by the backend, not rendered into nginx). Used to compute the default `target-url`; ignored when `target-url` is set. Publish mode only. |
| `path` | no | `dist` | Built bundle directory; also `workflow index --out`. Publish mode only. |
| `workflows` | no | `.bffless/workflows` | Directory of authored workflow YAML. Publish mode only. |
| `rules` | no | `.bffless/proxy-rules/<alias>` | The implementation's rule-set directory (contains `ruleset.yaml`). Publish mode only. |
| `harness-alias` | no | `workflow` | The alias carrying the union of implementation rule sets. |
| `name` | no | the alias | Display name on the Implementations screen. Publish mode only. |
| `description` | no | — | One line about the bundle. Publish mode only. |
| `prune` | no | `true` | Delete rules/schemas on the server that are absent from source. Publish mode only. |
| `lint-version` | no | `^1.0.0` | npm range for `@bffless/workflow-lint`. Publish mode only. |
| `preview` | no | `false` | Teardown mode only: opt in to tearing down an alias that does not match the preview grammar. |

## Outputs

| Output | Description |
| --- | --- |
| `rule-set-id` | Publish mode: the synced rule set ID (comma-separated if the set expanded to several). |
| `deployment-id` | Publish mode: the deployment ID of the uploaded bundle. |
| `index` | Publish mode: path of the written `index.json` (`<path>/.bffless/workflows/index.json`). |
| `target-url` | Publish mode: the resolved forwarder target — your `target-url` override, or the computed in-process default. |
| `detached` | Teardown mode: whether the harness alias was detached from the preview rule set. |
| `deleted-alias` | Teardown mode: whether the preview alias was deleted. |
| `deleted-rule-set` | Teardown mode: whether the preview rule set was deleted. |

## Still manual, per install

This action publishes an implementation. Standing the **harness** up on a domain is a
one-time setup it deliberately does not touch:

- **Domain → alias.** A domain for the **implementation** alias is now **optional** — the
  forwarder targets it in-process by default (above), so a domain here is purely cosmetic,
  letting a human browse the implementation host directly; previews need none at all. If
  you do add one, its domain path is `/<path>` (the action's `path` input, default
  `/dist`), not `/` — `bffless/upload-artifact` keeps the uploaded directory name as the
  bundle's root, so a domain path of `/` (or empty) 400s (double slash) or 404s instead of
  serving it. The **harness** alias's domain, by contrast, is not optional — its domain
  path is whatever the harness's own deploy uploads, outside this action's scope, and not
  necessarily `/dist`; match whatever directory that deploy's own `upload-artifact` step
  names. There is no API-driven step here yet for either; do it in the BFFless dashboard.
- **Two `no-transform` response-header rules.** Cloudflare Bot Fight Mode injects a script
  into every `text/html` response, which makes island HTML fetched and injected into a
  `srcdoc` throw `SecurityError`. Until [bffless/ce#700](https://github.com/bffless/ce/issues/700)
  ships them as part of the app, add header rules sending `Cache-Control: no-transform` for
  the island and harness HTML paths.
- **Bucket CORS.** The storage bucket must list the harness origin (e.g.
  `https://workflow.j5s.dev`), or browser uploads fail with a status-less
  "upload PUT failed". Probe with `curl -X OPTIONS`.
- **A `contributor` project role for the API key.** An API key is never admin —
  `api-key.guard` pins the role to `user`, and `project_permissions` rows are the only
  authority. Reading the harness aliases needs **`viewer`**; the attach step's `PATCH`, and
  teardown's `PATCH`/`DELETE alias`/`DELETE rule set`, need **`contributor`**
  (`deployments.service.ts` `updateAlias` → `checkProjectAccess(..., 'contributor')`).
  Grant the key's user `contributor` on the harness project. See
  [bffless/ce#701](https://github.com/bffless/ce/issues/701).

## Development

```bash
npm ci
npm test        # node --test; no vitest, no build step
```

`scripts/lib.mjs` holds the plumbing `attach.mjs` and `teardown.mjs` share (the CE aliases
contract, `request`/`parseArgs`/`isMainModule`). `scripts/prepare-rules.mjs` is the only one
with a runtime dependency (`yaml`); the rest of `scripts/` has none. The composite runs
`npm ci --omit=dev` in `$GITHUB_ACTION_PATH` before calling any of them. There is no
`dist/` to keep in sync.

## Licence

See [LICENSE.md](LICENSE.md).
