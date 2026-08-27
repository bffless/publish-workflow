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
    target-url: https://hello.j5s.dev
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
   `name:` to the alias and (b) generates the **`/w/<alias>/*` forwarder** with
   `targetUrl: <target-url>`. Your checkout is never modified.
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

`targetUrl` is a per-install value today — hence the required `target-url` input. Once
[bffless/ce#698](https://github.com/bffless/ce/issues/698) lands `targetUrl: alias://<impl>`
the input becomes optional and the rule becomes declarative.

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
    target-url: https://hello-pr-${{ github.event.number }}.j5s.dev
```

`target-url` above assumes the install maps `hello-pr-<n>.j5s.dev` to the preview alias.
Nothing here creates that mapping — a preview alias is still fully discoverable and attached
to the harness without one, which is what `mode: teardown` (below) cleans up.

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
          target-url: https://hello-pr-${{ github.event.number }}.j5s.dev

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

**Idempotent.** Every step tolerates "already gone": closing the same PR twice, or a
teardown that runs after a manual cleanup, makes no write and exits 0.

**Refuses a non-preview alias.** `alias` must match `^[a-z][a-z0-9-]*-pr-[0-9]+$`, or the
step fails **before making any request** — the API key's `contributor` role can repoint or
delete any alias on the harness project, so a plain `alias: hello` (production) must not
reach teardown by accident. To tear down a non-preview alias on purpose, pass `preview: true`.

**Never deletes a rule set it didn't publish.** Before deleting a rule set, teardown
re-fetches it and confirms its `name` matches `alias`; a mismatch refuses rather than
deleting.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `mode` | no | `publish` | `publish` (build + deploy + attach) or `teardown` (delete a preview and detach it). |
| `alias` | yes | — | The implementation alias, e.g. `hello`. `^[a-z][a-z0-9-]*$`; `workflow`, `w`, `auth` and `_bffless` are reserved. |
| `api-url` | yes | — | Base URL of the BFFless instance, e.g. `https://j5s.dev`. |
| `api-key` | yes | — | API key (`X-API-Key`). Needs a **project role** on the harness project — see below. |
| `repository` | yes | — | The **harness** project, `owner/name`. The alias and the rule set are created there. |
| `target-url` | no | — | The implementation alias host the forwarder points at, e.g. `https://hello.j5s.dev`. Required in publish mode until bffless/ce#698; unused in teardown mode. |
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
| `detached` | Teardown mode: whether the harness alias was detached from the preview rule set. |
| `deleted-alias` | Teardown mode: whether the preview alias was deleted. |
| `deleted-rule-set` | Teardown mode: whether the preview rule set was deleted. |

## Still manual, per install

This action publishes an implementation. Standing the **harness** up on a domain is a
one-time setup it deliberately does not touch:

- **Domain → alias.** Point the domain at the harness alias with base path `/`. There is no
  API-driven step here yet; do it in the BFFless dashboard.
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

`scripts/prepare-rules.mjs` and `scripts/attach.mjs` are plain ESM with one runtime
dependency (`yaml`); `scripts/teardown.mjs` has none. The composite runs
`npm ci --omit=dev` in `$GITHUB_ACTION_PATH` before calling any of them. There is no
`dist/` to keep in sync.

## Licence

See [LICENSE.md](LICENSE.md).
