import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

// actionlint (1.7.7) parses every file it is given as a *workflow*, so it cannot check a
// composite action.yml. These assertions are the stand-in: they hold the file to the
// contract the README documents and catch the typo actionlint would have caught —
// an expression naming a step id or an input that does not exist.
//
// v2 publishes through `npx @bffless/workflow publish`, so what used to be pinned here by
// prepare-rules.test.mjs / attach.test.mjs is pinned by that package's own suite (its
// prepare/attach are ports of those scripts, tested against the fixtures this repo used to
// carry). What remains in-repo — and therefore still tested here — is teardown, the input
// resolution the CLI cannot do for us, and the input → flag mapping of the wrapper itself.
const action = parse(readFileSync(fileURLToPath(new URL('../action.yml', import.meta.url)), 'utf8'))

const step = (idOrName) => action.runs.steps.find((s) => s.id === idOrName || s.name === idOrName)

/** Run one step's `run:` script under bash with `env`, capturing $GITHUB_OUTPUT. */
function runStep(target, env = {}, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-workflow-step-'))
  const out = join(dir, 'out')
  try {
    const stdout = execFileSync('bash', ['-c', step(target).run], {
      env: { ...process.env, ...env, GITHUB_OUTPUT: out },
      stdio: 'pipe',
      ...extra,
    })
    return { failed: false, stdout: String(stdout), file: existsSync(out) ? readFileSync(out, 'utf8') : '' }
  } catch (e) {
    return {
      failed: true,
      stdout: String(e.stdout ?? ''),
      file: existsSync(out) ? readFileSync(out, 'utf8') : '',
    }
  }
}

test('declares the documented inputs, with the documented defaults', () => {
  assert.deepEqual(Object.keys(action.inputs).sort(), [
    'alias', 'api-key', 'api-url', 'backend-url', 'description', 'harness-alias', 'lint-version',
    'mode', 'name', 'path', 'preview', 'prune', 'repository', 'rules', 'target-url',
    'workflow-version', 'workflows',
  ])
  // v2: only the three the CLI cannot derive from the checkout stay required.
  for (const required of ['api-url', 'api-key', 'repository']) {
    assert.equal(action.inputs[required].required, true, `${required} must be required`)
  }
  // The v2 headline: alias now defaults to the identity file beside the workflows dir.
  assert.equal(action.inputs.alias.required, false)
  assert.equal(action.inputs.alias.default, '')
  // harness-alias likewise — '' means "the identity file's `harness`, else workflow".
  assert.equal(action.inputs['harness-alias'].required, false)
  assert.equal(action.inputs['harness-alias'].default, '')
  assert.equal(action.inputs.path.default, 'dist')
  assert.equal(action.inputs.workflows.default, '.bffless/workflows')
  assert.equal(action.inputs.rules.default, '')
  assert.equal(action.inputs.name.default, '')
  assert.equal(action.inputs.description.default, '')
  // 1.1.0 is the floor: the release that added `publish --name` / `--description`
  // (bffless/apps#569), which the name/description inputs are mapped onto.
  assert.equal(action.inputs['workflow-version'].default, '^1.1.0')
  assert.equal(action.inputs.mode.default, 'publish')
  assert.equal(action.inputs.preview.default, 'false')
})

test('name and description are ordinary supported inputs, not guarded ones', () => {
  // They were blocked when v2 was first written (`workflow publish` had no flags for
  // them); bffless/apps#569 added both, so they are carried through again with v1's
  // semantics — name defaulting to the alias, description to absent, both CLI-side.
  for (const supported of ['name', 'description']) {
    assert.doesNotMatch(action.inputs[supported].description, /REMOVED in v2/)
    assert.ok(
      !step('Reject inputs v2 cannot carry').env[supported.toUpperCase()],
      `${supported} must not be read by the removed-input guard`,
    )
  }
})

test('the v1 inputs v2 cannot carry are still declared, so setting one fails loudly', () => {
  // Removing them outright would only make GitHub warn ("Unexpected input(s)") and run
  // anyway — silently changing what gets published. Each is declared with its v1 default
  // so an *unset* one is indistinguishable from absent, and guarded by the step below.
  for (const removed of ['target-url', 'lint-version']) {
    assert.equal(action.inputs[removed].default, '', `${removed} must default to empty`)
    assert.match(action.inputs[removed].description, /REMOVED in v2/)
  }
  assert.equal(action.inputs['backend-url'].default, 'http://localhost:3000')
  assert.equal(action.inputs.prune.default, 'true')
})

test('declares the documented outputs', () => {
  // rule-set-id, deployment-id and target-url are gone: they live inside the CLI, which
  // prints only a human report (no --json, no ids), and scraping its stdout is not a
  // contract this action is willing to pin.
  assert.deepEqual(Object.keys(action.outputs).sort(), [
    'alias', 'deleted-alias', 'deleted-rule-set', 'detached', 'harness-alias', 'index',
  ])
})

test('is a composite action that wraps the CLI instead of composing other actions', () => {
  assert.equal(action.runs.using, 'composite')
  const uses = action.runs.steps.map((s) => s.uses).filter(Boolean)
  // v1 composed bffless/deploy-proxy-rules@v1 + bffless/upload-artifact@v1; the CLI does
  // both now (a `bffless rules push` spawn and a multipart zip upload), so setup-node is
  // the only remaining `uses:`.
  assert.deepEqual(uses, ['actions/setup-node@v4'])
})

test('every ${{ steps.X.outputs.Y }} names a step declared earlier', () => {
  const ids = new Set()
  const check = (text, where) => {
    for (const [, id] of String(text).matchAll(/\$\{\{\s*steps\.([\w-]+)\./g)) {
      assert.ok(ids.has(id), `${where} references steps.${id} which is not declared before it`)
    }
  }
  for (const s of action.runs.steps) {
    check(JSON.stringify(s), `step "${s.name ?? s.uses}"`)
    if (s.id) ids.add(s.id)
  }
  check(JSON.stringify(action.outputs), 'outputs')
})

test('publish and teardown steps are gated on their mode; the shared steps are not', () => {
  // "Resolve inputs" is ungated in v2: teardown needs the resolved harness alias too.
  const ungated = new Set(['Validate mode', 'actions/setup-node@v4', 'Resolve inputs'])
  for (const s of action.runs.steps) {
    const label = s.name ?? s.uses
    if (ungated.has(label)) {
      assert.equal(s.if, undefined, `"${label}" must not be gated on mode`)
    } else if (s.id === 'teardown') {
      assert.equal(s.if, "inputs.mode == 'teardown'", `"${label}" must be gated on teardown mode`)
    } else {
      assert.equal(s.if, "inputs.mode == 'publish'", `"${label}" must be gated on publish mode`)
    }
  }
})

test('the teardown step calls scripts/teardown.mjs with the api key in the environment, never argv', () => {
  const s = step('teardown')
  assert.ok(s, 'a step with id "teardown" must exist')
  assert.equal(s.env.BFFLESS_API_KEY, '${{ inputs.api-key }}')
  assert.doesNotMatch(s.run, /--api-key/)
  assert.match(s.run, /teardown\.mjs/)
  assert.match(s.run, />> "\$GITHUB_OUTPUT"/)
  // It must read the RESOLVED alias/harness-alias, not the raw inputs — harness-alias is
  // blank whenever the identity-file default applies.
  assert.equal(s.env.ALIAS, '${{ steps.cfg.outputs.alias }}')
  assert.equal(s.env.HARNESS_ALIAS, '${{ steps.cfg.outputs.harness-alias }}')
})

test('every ${{ inputs.X }} names a declared input', () => {
  const declared = new Set(Object.keys(action.inputs))
  for (const [, name] of JSON.stringify(action.runs).matchAll(/\$\{\{\s*inputs\.([\w-]+)\s*\}\}/g)) {
    assert.ok(declared.has(name), `inputs.${name} is referenced but not declared`)
  }
})

test('never interpolates an input straight into a run: script', () => {
  // Inputs reach shell steps through env:, so a value containing `"; rm -rf /` is data.
  for (const s of action.runs.steps) {
    if (!s.run) continue
    assert.doesNotMatch(s.run, /\$\{\{\s*inputs\./, `step "${s.name}" interpolates an input into run:`)
  }
})

// ---------------------------------------------------------------------------
// Validate mode

test('Validate mode is the first step, ungated, and accepts publish/teardown', () => {
  const s = step('Validate mode')
  assert.ok(s, 'a step named "Validate mode" must exist')
  assert.equal(action.runs.steps[0], s, 'it must run before setup-node')
  assert.equal(s.if, undefined)
  assert.equal(runStep('Validate mode', { MODE: 'publish' }).failed, false)
  assert.equal(runStep('Validate mode', { MODE: 'teardown' }).failed, false)
})

test('Validate mode rejects anything else', () => {
  for (const bad of ['Teardown', 'PUBLISH', 'delete', '']) {
    const { failed, stdout } = runStep('Validate mode', { MODE: bad })
    assert.equal(failed, true, `mode "${bad}" should fail validation`)
    assert.match(stdout, /::error::input `mode` must be "publish" or "teardown"/)
  }
})

// ---------------------------------------------------------------------------
// Reject inputs v2 cannot carry

const REJECT_DEFAULTS = {
  TARGET_URL: '', BACKEND_URL: 'http://localhost:3000', PRUNE: 'true', LINT_VERSION: '',
}
const runReject = (env) => runStep('Reject inputs v2 cannot carry', { ...REJECT_DEFAULTS, ...env })

test('the v1 defaults for the removed inputs pass the guard untouched', () => {
  assert.equal(runReject({}).failed, false)
})

test('each removed input fails the run, naming itself', () => {
  const cases = [
    [{ TARGET_URL: 'https://hello.j5s.dev' }, /input `target-url` was removed in v2/],
    [{ BACKEND_URL: 'http://ce:3000' }, /input `backend-url` was removed in v2/],
    [{ PRUNE: 'false' }, /input `prune` was removed in v2/],
    [{ LINT_VERSION: '^1.0.0' }, /input `lint-version` was removed in v2/],
  ]
  for (const [env, re] of cases) {
    const { failed, stdout } = runReject(env)
    assert.equal(failed, true, `${JSON.stringify(env)} should fail`)
    assert.match(stdout, /::error::/)
    assert.match(stdout, re)
  }
})

test('every removed input is reported in one run, not one per re-run', () => {
  // A migration wants the whole list at once; failing on the first would make the user
  // re-run the workflow once per offending input to find them all.
  const { failed, stdout } = runReject({ TARGET_URL: 'https://x.j5s.dev', PRUNE: 'false', LINT_VERSION: '^1.0.0' })
  assert.equal(failed, true)
  assert.equal(stdout.match(/::error::/g).length, 3)
})

// ---------------------------------------------------------------------------
// Resolve inputs — the identity-file defaults, and the $GITHUB_OUTPUT guards

const CFG_DEFAULTS = {
  MODE: 'publish', ALIAS: '', HARNESS_ALIAS: '', RULES: '', OUT: 'dist',
  WORKFLOWS: '.bffless/workflows', REPOSITORY: 'bffless/workflow', API_URL: 'https://j5s.dev',
}

/** A checkout with an implementation at `implDir` ('.' for the repo root) carrying `identity`. */
function workspace(identity, implDir = '.') {
  const root = mkdtempSync(join(tmpdir(), 'publish-workflow-ws-'))
  const bffless = join(root, implDir, '.bffless')
  mkdirSync(join(bffless, 'workflows'), { recursive: true })
  if (identity !== null) {
    writeFileSync(join(bffless, 'workflow.json'), typeof identity === 'string' ? identity : JSON.stringify(identity))
  }
  const prefix = implDir === '.' ? '' : `${implDir}/`
  return { root, workflows: `${prefix}.bffless/workflows` }
}

const runCfg = (env, cwd) => runStep('Resolve inputs', { ...CFG_DEFAULTS, ...env }, cwd ? { cwd } : {})

test('Resolve inputs defaults alias and harness-alias from the identity file', () => {
  const ws = workspace({ alias: 'hello', harness: 'workflow' })
  const { failed, file } = runCfg({ WORKFLOWS: ws.workflows }, ws.root)
  assert.equal(failed, false)
  assert.equal(file, 'alias=hello\nharness-alias=workflow\nindex=dist/.bffless/workflows/index.json\n')
})

test('Resolve inputs finds the identity file beside a NESTED implementation\'s workflows dir', () => {
  // The CLI reads .bffless/workflow.json relative to its own cwd, which in an action is
  // always $GITHUB_WORKSPACE — so a package at packages/hello/ would never be found. The
  // action derives it from the `workflows` input instead and passes --alias explicitly.
  const ws = workspace({ alias: 'hello', harness: 'studio' }, 'packages/hello')
  const { failed, file } = runCfg({ WORKFLOWS: ws.workflows, OUT: 'packages/hello/dist' }, ws.root)
  assert.equal(failed, false)
  assert.match(file, /^alias=hello$/m)
  assert.match(file, /^harness-alias=studio$/m)
  assert.match(file, /^index=packages\/hello\/dist\/\.bffless\/workflows\/index\.json$/m)
})

test('Resolve inputs prefers an explicit alias / harness-alias over the identity file', () => {
  const ws = workspace({ alias: 'hello', harness: 'workflow' })
  const { failed, file } = runCfg(
    { WORKFLOWS: ws.workflows, ALIAS: 'hello-pr-12', HARNESS_ALIAS: 'staging' },
    ws.root,
  )
  assert.equal(failed, false)
  assert.match(file, /^alias=hello-pr-12$/m)
  assert.match(file, /^harness-alias=staging$/m)
})

test('Resolve inputs falls back to harness-alias "workflow" with no identity file', () => {
  const ws = workspace(null)
  const { failed, file } = runCfg({ WORKFLOWS: ws.workflows, ALIAS: 'hello' }, ws.root)
  assert.equal(failed, false)
  assert.match(file, /^harness-alias=workflow$/m)
})

test('Resolve inputs fails when no alias can be resolved', () => {
  for (const identity of [null, '{ not json', {}, { alias: 42, harness: 'workflow' }]) {
    const ws = workspace(identity)
    const { failed, stdout, file } = runCfg({ WORKFLOWS: ws.workflows }, ws.root)
    assert.equal(failed, true, `identity ${JSON.stringify(identity)} should not yield an alias`)
    assert.match(stdout, /::error::input `alias` is required/)
    assert.equal(file, '')
  }
})

test('Resolve inputs never defaults the alias in teardown mode', () => {
  // The identity file names the PRODUCTION alias; teardown deletes what it is given.
  const ws = workspace({ alias: 'hello', harness: 'workflow' })
  const { failed, stdout } = runCfg({ WORKFLOWS: ws.workflows, MODE: 'teardown' }, ws.root)
  assert.equal(failed, true)
  assert.match(stdout, /::error::input `alias` is required in teardown mode/)
})

test('Resolve inputs still resolves harness-alias from the identity file in teardown mode', () => {
  const ws = workspace({ alias: 'hello', harness: 'studio' })
  const { failed, file } = runCfg(
    { WORKFLOWS: ws.workflows, MODE: 'teardown', ALIAS: 'hello-pr-12' },
    ws.root,
  )
  assert.equal(failed, false)
  assert.match(file, /^alias=hello-pr-12$/m)
  assert.match(file, /^harness-alias=studio$/m)
})

test('Resolve inputs rejects an alias that is not a valid alias, from either source', () => {
  const ws = workspace({ alias: 'Hello World', harness: 'workflow' })
  const fromFile = runCfg({ WORKFLOWS: ws.workflows }, ws.root)
  assert.equal(fromFile.failed, true)
  assert.match(fromFile.stdout, /::error::alias "Hello World" is not a valid alias/)
  assert.equal(fromFile.file, '')

  const fromInput = runCfg({ WORKFLOWS: ws.workflows, ALIAS: '9lives' }, ws.root)
  assert.equal(fromInput.failed, true)
  assert.match(fromInput.stdout, /::error::alias "9lives" is not a valid alias/)

  const badHarness = runCfg({ WORKFLOWS: ws.workflows, ALIAS: 'hello', HARNESS_ALIAS: 'A' }, ws.root)
  assert.equal(badHarness.failed, true)
  assert.match(badHarness.stdout, /::error::harness-alias "A" is not a valid alias/)
})

test('Resolve inputs rejects a newline in any guarded input', () => {
  for (const key of ['ALIAS', 'HARNESS_ALIAS', 'RULES', 'OUT', 'WORKFLOWS', 'REPOSITORY', 'API_URL']) {
    const { failed, stdout, file } = runCfg({ [key]: 'evil\nindex=/etc/passwd' })
    assert.equal(failed, true, `${key} with a newline should fail the step`)
    assert.match(stdout, /::error::input `[a-z-]+` must not contain a newline/)
    assert.equal(file, '', `${key} must not have written any output`)
  }
})

// ---------------------------------------------------------------------------
// Publish — the input → flag mapping, run against a stub `npx`

/** A PATH whose `npx` records its argv instead of running anything. */
function stubNpx() {
  const dir = mkdtempSync(join(tmpdir(), 'publish-workflow-npx-'))
  const log = join(dir, 'argv')
  const bin = join(dir, 'npx')
  writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\n`)
  chmodSync(bin, 0o755)
  return { PATH: `${dir}${delimiter}${process.env.PATH}`, argv: () => readFileSync(log, 'utf8').trim().split('\n') }
}

const PUBLISH_DEFAULTS = {
  BFFLESS_API_KEY: 'secret', WORKFLOW_VERSION: '^1.1.0', API_URL: 'https://j5s.dev',
  REPOSITORY: 'bffless/workflow', ALIAS: 'hello', HARNESS_ALIAS: 'workflow', OUT: 'dist',
  WORKFLOWS: '.bffless/workflows', RULES: '', NAME: '', DESCRIPTION: '',
}

function runPublish(env = {}) {
  const npx = stubNpx()
  const res = runStep('Publish the implementation', { ...PUBLISH_DEFAULTS, ...env, PATH: npx.PATH })
  return { ...res, argv: npx.argv() }
}

test('the publish step invokes the pinned CLI with every input mapped to its flag', () => {
  const { failed, argv } = runPublish({
    RULES: '.bffless/proxy-rules/hello',
    NAME: 'Hello World',
    DESCRIPTION: 'A demo implementation.',
  })
  assert.equal(failed, false)
  assert.deepEqual(argv, [
    '--yes', '@bffless/workflow@^1.1.0', 'publish',
    '--api-url', 'https://j5s.dev',
    '--project', 'bffless/workflow',
    '--alias', 'hello',
    '--harness-alias', 'workflow',
    '--path', 'dist',
    '--workflows', '.bffless/workflows',
    '--rules', '.bffless/proxy-rules/hello',
    '--name', 'Hello World',
    '--description', 'A demo implementation.',
  ])
})

test('the publish step omits --rules / --name / --description when the input is blank', () => {
  // Each has a CLI-side default that is exactly what v1 resolved in its own step
  // (.bffless/proxy-rules/<alias>, the alias, and absent respectively), and passing
  // `--rules ''` would be a usage error rather than "use the default".
  const argv = runPublish().argv
  for (const flag of ['--rules', '--name', '--description']) {
    assert.ok(!argv.includes(flag), `${flag} must be omitted, not passed empty`)
  }
})

test('the publish step passes a multi-word name/description as one argument each', () => {
  // They reach the step through env: and the array through "$NAME", so a value with
  // spaces (every real display name) must not word-split into extra argv entries.
  const argv = runPublish({ NAME: 'Hello World', DESCRIPTION: 'One line; two words.' }).argv
  assert.equal(argv[argv.indexOf('--name') + 1], 'Hello World')
  assert.equal(argv[argv.indexOf('--description') + 1], 'One line; two words.')
  // npx + spec + verb + 6 always-on flag pairs + the two pairs above; nothing split.
  assert.equal(argv.length, 3 + 12 + 4)
})

test('the publish step passes the api key only through the environment', () => {
  const { argv, stdout } = runPublish()
  assert.ok(!argv.includes('--api-key'), 'the key must never reach argv')
  assert.ok(!argv.some((a) => a.includes('secret')), 'the key must never reach argv')
  assert.doesNotMatch(stdout, /secret/)
  assert.equal(step('publish').env.BFFLESS_API_KEY, '${{ inputs.api-key }}')
})

test('the publish step honours workflow-version, and reads the resolved alias', () => {
  assert.ok(runPublish({ WORKFLOW_VERSION: '2.1.0' }).argv.includes('@bffless/workflow@2.1.0'))
  const s = step('publish')
  assert.equal(s.env.ALIAS, '${{ steps.cfg.outputs.alias }}')
  assert.equal(s.env.HARNESS_ALIAS, '${{ steps.cfg.outputs.harness-alias }}')
})

test('the publish step fails when the CLI fails', () => {
  // `set -euo pipefail` plus a bare `npx` call — no `|| true` anywhere on the path.
  const dir = mkdtempSync(join(tmpdir(), 'publish-workflow-npx-'))
  writeFileSync(join(dir, 'npx'), '#!/usr/bin/env bash\nexit 2\n')
  chmodSync(join(dir, 'npx'), 0o755)
  const { failed } = runStep('Publish the implementation', {
    ...PUBLISH_DEFAULTS,
    PATH: `${dir}${delimiter}${process.env.PATH}`,
  })
  assert.equal(failed, true)
})
