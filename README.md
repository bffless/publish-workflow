# `bffless/publish-workflow`

Publishes a **BFFless Workflow implementation** from CI, and tears its previews down again.

Since **v2** the publish path is a thin wrapper around
[`@bffless/workflow`](https://www.npmjs.com/package/@bffless/workflow)'s `publish` verb —
the authoring CLI does the four moves, this action supplies CI's half: the alias defaults,
the preview lifecycle, and a loud failure when you ask for something the CLI can't do.

```yaml
- uses: bffless/publish-workflow@v2
  with:
    api-url: https://j5s.dev
    api-key: ${{ secrets.BFFLESS_API_KEY }}
    repository: bffless/workflow
```

No `alias:` — it comes from the implementation's own `.bffless/workflow.json`.

> **v2 needs `@bffless/workflow` >= 1.1.0**, the release that added
> `publish --name` / `--description` ([bffless/apps#569](https://github.com/bffless/apps/pull/569)) —
> the `workflow-version` default (`^1.1.0`) already pins that floor. Narrow it below 1.1.0
> and those two inputs become a usage error inside the CLI.

## What it does

The obligations are spec'd in `apps/workflow/docs/spec/06-discovery-publishing-files.md`
("Implementation CI obligations"). In order:

1. **Build** — yours. Run it before this action; `path` (default `dist`) is what it produced.
2. **Resolve the alias** — this action's own step. `alias` and `harness-alias` default to
   the `alias` / `harness` in the **identity file**, `.bffless/workflow.json`, found beside
   the `workflows` directory (`<dirname of workflows>/workflow.json`).
3. **Publish** — one `npx --yes @bffless/workflow@<workflow-version> publish` call, which
   runs the remaining four moves in process:
   - **index** — lints every YAML under `workflows` *against the rule set being published*
     and, only if all of them pass, writes `<path>/.bffless/workflows/` (the YAMLs plus the
     generated `index.json` the harness reads) and a landing `index.html`. **A failing lint
     fails the publish** — the linter's `rule-missing` check holds every relative
     `with.path` / `poll.path` to the rule that will serve it, so a typo on either side is
     caught here instead of as a run-time 404. `name` and `description` land in that
     `index.json` (the Implementations screen reads them) via the CLI's
     `--name` / `--description`.
   - **prepare** — stages a copy of the rule set under a temp dir, rewrites `ruleset.yaml`'s
     `name:` to the alias, and generates the **`/w/<alias>/*` forwarder** (below). Your
     checkout is never modified.
   - **rules push** — `npx bffless@0.3.3 rules push` syncs the staged set as **`<alias>`**
     with every *derived* rule path rewritten under `/api/<alias>/`, pruning what source no
     longer has.
   - **upload + attach** — zips `path` to alias `<alias>` (`basePath: /`, its own rule set
     attached by name), then unions that rule set's id into the **harness alias'**
     `proxyRuleSetIds`. Idempotent: publishing the same implementation twice makes no
     *write* the second time.

On PR close, tear the preview down with `mode: teardown` (below) — the inverse of the last
move, plus deleting the preview's own alias and rule set. **Teardown stays in this action**:
preview lifecycle is CI's concern, and the CLI deliberately has no teardown verb.

### Why the wrapper

The CLI's `prepare` and `attach` are **ports of this action's own v1 scripts**, pinned
against the fixtures this repo used to carry (`prepare-rules.test.mjs`'s cases 1:1, the
union-PATCH line for line, the forwarder YAML byte-compatible). v2 is a re-pointing, not a
re-implementation: the same behaviour, with one published implementation instead of two.

### Why the forwarder

Everything the browser talks to must be **one origin** — the harness host (ADR-0001, D2).
Your bundle lives on its own alias host, so the harness needs a proxy rule that serves it
same-origin: `/w/<alias>/*` on the harness → your alias. The CLI generates that rule; the
source set must **not** contain `rules/_custom/forward` (it refuses if it does, rather than
silently overwriting a hand-authored rule).

The forwarder's `targetUrl` points at the alias **in-process** on the CE backend —
`http://localhost:3000/public/<owner>/<repo>/alias/<alias>/<path, as given>` (a rule
without `authTransform` is never rendered into nginx; it's forwarded in-process by the
backend itself, so the backend's own address is right for every CE install). No domain, no
per-install hostname, and it works for previews with nothing extra.

In v1 you could point the forwarder at a real domain instead (`target-url`) or move the
backend's own address (`backend-url`); **`workflow publish` has neither flag**, so v2 pins
the in-process form. [bffless/ce#698](https://github.com/bffless/ce/issues/698) —
`targetUrl: alias://<impl>` — remains a nice-to-have that would make the rule declarative
instead of a resolved URL, not a blocker.

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

**A preview run must pass both `alias:` and `rules:` explicitly.** `alias` is the one place
the identity-file default is *not* what you want — the identity file names the production
alias. And the rule-set directory on disk is named for the **implementation**, not for the
alias: `.bffless/proxy-rules/hello` stays put while the alias becomes `hello-pr-12`, so the
default (`.bffless/proxy-rules/<alias>`) would resolve to a directory that does not exist —
and an explicit rule set that does not resolve exits 2 before anything is deployed:

```yaml
- uses: bffless/publish-workflow@v2
  with:
    alias: hello-pr-${{ github.event.number }}
    rules: .bffless/proxy-rules/hello        # named for the impl, not the alias
    api-url: https://j5s.dev
    api-key: ${{ secrets.BFFLESS_API_KEY }}
    repository: bffless/workflow
```

A preview alias is fully discoverable and attached to the harness with zero domain setup.
What accumulates instead, and what `mode: teardown` cleans up, are the preview alias itself,
its rule set, and the harness attachment.

### Preview teardown (`mode: teardown`)

On PR close, delete the preview alias and its rule set, and detach it from the harness
alias. It needs no build, no bundle and no lint, so none of `path` or `workflows` are read
in this mode — except that `workflows` still locates the identity file `harness-alias`
defaults from, so a teardown job wanting that default needs the checkout:

```yaml
- uses: actions/checkout@v4
- uses: bffless/publish-workflow@v2
  with:
    mode: teardown
    alias: hello-pr-${{ github.event.number }}
    api-url: https://j5s.dev
    api-key: ${{ secrets.BFFLESS_API_KEY }}
    repository: bffless/workflow
```

**`alias` is required here.** It is never defaulted from the identity file: that file names
the production alias, and teardown deletes what it is given.

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
      - uses: actions/checkout@v4
      # ... build the bundle into dist/ ...
      - uses: bffless/publish-workflow@v2
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
      - uses: actions/checkout@v4
      - uses: bffless/publish-workflow@v2
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

## Migrating from v1

| v1 input | v2 | Why |
| --- | --- | --- |
| `alias` | **now optional** | Defaults to `.bffless/workflow.json`'s `alias`. Still required in teardown mode, and still worth passing explicitly for a preview. |
| `harness-alias` (default `workflow`) | **default is now the identity file** | `.bffless/workflow.json`'s `harness`, falling back to `workflow` when there is no identity file. |
| `mode`, `api-url`, `api-key`, `repository`, `path`, `workflows`, `rules`, `preview` | unchanged | — |
| `name`, `description` | unchanged | Mapped to the CLI's `--name` / `--description` ([bffless/apps#569](https://github.com/bffless/apps/pull/569), `@bffless/workflow` 1.1.0). Same defaults as v1 — `name` falls back to the alias, `description` to absent — resolved CLI-side now rather than in this action's own step. |
| `lint-version` | **removed** → use `workflow-version` | The linter is now an internal dependency of `@bffless/workflow`; what you pin is the CLI. |
| `target-url` | **removed — fails the run** | `workflow publish` always forwards in-process. Need a real domain? Stay on `@v1`. |
| `backend-url` | **removed — fails a non-default value** | `workflow publish` pins `http://localhost:3000`. |
| `prune` | **removed — `prune: false` fails the run** | `workflow publish` always passes `--prune`; accepting `false` and pruning anyway would be the worst kind of silent. |

| v1 output | v2 | Why |
| --- | --- | --- |
| `index` | unchanged | Computed from `path`, not from the CLI. |
| `alias`, `harness-alias` | **new** | The resolved values, so a later step can name what was published. |
| `detached`, `deleted-alias`, `deleted-rule-set` | unchanged | Teardown is still in-repo. |
| `rule-set-id` | **removed** | The id is resolved inside the CLI, which prints a human report only — no `--json`, no ids. |
| `deployment-id` | **removed** | Same: it appears in the CLI's log line and nowhere machine-readable. |
| `target-url` | **removed** | The forwarder target is no longer this action's to compute. |

The removed inputs are still *declared*, so setting one **fails the run with an explaining
error**. Dropping them from `action.yml` outright would only make GitHub warn ("Unexpected
input(s)") and then publish something different from what you asked for.

Other behaviour differences worth knowing:

- **`index.json`'s `commit`** is now `GITHUB_SHA` truncated to 7 characters (the CLI's own
  default) rather than the full 40 v1 passed with `--commit`. Display only.
- **The deployment's `commitSha`** is `git rev-parse HEAD` in the checkout rather than
  `github.sha`. For `actions/checkout@v4` on `push` and `pull_request` these are the same
  commit (a `pull_request`'s `github.sha` *is* the merge commit checkout checks out); they
  diverge only when the workflow checks out a custom `ref:`, and then the CLI's value
  describes the tree that was actually built. Outside a git repo it falls back to a
  format-valid all-zero placeholder, which CI never hits.
- **No step summaries.** v1 got them free from `deploy-proxy-rules` / `upload-artifact`;
  the CLI writes to the job log instead.
- **`harness-alias` is now validated** against the same `^[a-z][a-z0-9-]*$` alias grammar
  as `alias` (both end up on the CLI's command line and in `$GITHUB_OUTPUT`). v1 checked
  only `alias`, and only later, inside the prepare script.
- **The API key's required scope is unchanged** — `viewer` to read the harness aliases,
  `contributor` for the attach `PATCH`. The CLI resolves the rule-set id with two extra
  reads (`GET /api/projects/:owner/:name`, `GET /api/proxy-rule-sets/project/:id`) where v1
  read it off `deploy-proxy-rules`' output; both are `viewer`-level reads on the same
  project, so nothing new needs granting.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `mode` | no | `publish` | `publish` (build + deploy + attach) or `teardown` (delete a preview and detach it). |
| `alias` | no | the identity file's `alias` | The implementation alias, e.g. `hello`. `^[a-z][a-z0-9-]*$`; `workflow`, `w`, `auth` and `_bffless` are reserved. **Required in teardown mode.** |
| `api-url` | yes | — | Base URL of the BFFless instance, e.g. `https://j5s.dev`. |
| `api-key` | yes | — | API key (`X-API-Key`). Needs a **project role** on the harness project — see below. Reaches the CLI as `BFFLESS_API_KEY`, never argv. |
| `repository` | yes | — | The **harness** project, `owner/name`. The alias and the rule set are created there. |
| `path` | no | `dist` | Built bundle directory; also the CLI's `--path`. Publish mode only. |
| `workflows` | no | `.bffless/workflows` | Directory of authored workflow YAML. Its parent also locates the identity file. |
| `rules` | no | `.bffless/proxy-rules/<alias>` | The implementation's rule-set directory (contains `ruleset.yaml`). Publish mode only. |
| `harness-alias` | no | the identity file's `harness`, else `workflow` | The alias carrying the union of implementation rule sets. |
| `name` | no | the alias | Display name on the Implementations screen. Publish mode only. |
| `description` | no | — | One line about the bundle. Publish mode only. |
| `workflow-version` | no | `^1.1.0` | npm range for `@bffless/workflow`, the CLI this action wraps. **1.1.0 is the floor** — the release carrying `publish --name`/`--description`. |
| `preview` | no | `false` | Teardown mode only: opt in to tearing down an alias that does not match the preview grammar. |
| `target-url`, `backend-url`, `prune`, `lint-version` | no | v1's defaults | **Removed in v2** — declared only so that setting one fails loudly. See [Migrating from v1](#migrating-from-v1). |

## Outputs

| Output | Description |
| --- | --- |
| `alias` | The resolved implementation alias — the input, or the identity file's. |
| `harness-alias` | The resolved harness alias — the input, the identity file's `harness`, or `workflow`. |
| `index` | Publish mode: path of the written `index.json` (`<path>/.bffless/workflows/index.json`). |
| `detached` | Teardown mode: whether the harness alias was detached from the preview rule set. |
| `deleted-alias` | Teardown mode: whether the preview alias was deleted. |
| `deleted-rule-set` | Teardown mode: whether the preview rule set was deleted. |

## Still manual, per install

This action publishes an implementation. Standing the **harness** up on a domain is a
one-time setup it deliberately does not touch:

- **Domain → alias.** A domain for the **implementation** alias is **optional** — the
  forwarder targets it in-process, so a domain here is purely cosmetic, letting a human
  browse the implementation host directly; previews need none at all. If you do add one,
  its domain path is `/<path>` (the action's `path` input, default `/dist`), not `/` — the
  uploaded directory name stays the bundle's root, so a domain path of `/` (or empty) 400s
  (double slash) or 404s instead of serving it. The **harness** alias's domain, by contrast,
  is not optional — its domain path is whatever the harness's own deploy uploads, outside
  this action's scope, and not necessarily `/dist`. There is no API-driven step here yet for
  either; do it in the BFFless dashboard.
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

`scripts/teardown.mjs` is the only script left — the publish path moved into
`@bffless/workflow` — and `scripts/lib.mjs` holds the CE aliases contract it reads
(`request`/`parseArgs`/`isMainModule`). Neither has a runtime dependency, so the composite
installs nothing at run time; `yaml` is a devDependency, used only by the tests. There is no
`dist/` to keep in sync.

`test/action.test.mjs` executes the composite's shell steps for real — the mode guard, the
removed-input guard, the identity-file resolution, and the publish step's input → flag
mapping (against a stub `npx` that records its argv). What used to live here as
`prepare-rules.test.mjs` and `attach.test.mjs` is now `@bffless/workflow`'s own suite,
which those files' cases were ported into.

## Licence

See [LICENSE.md](LICENSE.md).
