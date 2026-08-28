import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

// actionlint (1.7.7) parses every file it is given as a *workflow*, so it cannot check a
// composite action.yml. These assertions are the stand-in: they hold the file to the
// contract the README documents and catch the typo actionlint would have caught —
// an expression naming a step id or an input that does not exist.
const action = parse(readFileSync(fileURLToPath(new URL('../action.yml', import.meta.url)), 'utf8'))

test('declares the documented inputs, with the documented defaults', () => {
  assert.deepEqual(Object.keys(action.inputs).sort(), [
    'alias', 'api-key', 'api-url', 'backend-url', 'description', 'harness-alias', 'lint-version',
    'mode', 'name', 'path', 'preview', 'prune', 'repository', 'rules', 'target-url', 'workflows',
  ])
  for (const required of ['alias', 'api-url', 'api-key', 'repository']) {
    assert.equal(action.inputs[required].required, true, `${required} must be required`)
  }
  // target-url is now a full override of the in-process default (below), and unused in
  // teardown mode either way, so it stays optional at the action level.
  assert.equal(action.inputs['target-url'].required, false)
  assert.equal(action.inputs['target-url'].default, '')
  // backend-url is the CE backend's own address, as reachable from the backend itself —
  // the forwarder is proxied in-process by the backend, not rendered into nginx — used
  // to compute the default target-url.
  assert.equal(action.inputs['backend-url'].default, 'http://localhost:3000')
  assert.equal(action.inputs.path.default, 'dist')
  assert.equal(action.inputs.workflows.default, '.bffless/workflows')
  assert.equal(action.inputs['harness-alias'].default, 'workflow')
  assert.equal(action.inputs.prune.default, 'true')
  // @bffless/workflow-lint is published at 1.0.0.
  assert.equal(action.inputs['lint-version'].default, '^1.0.0')
  assert.equal(action.inputs.mode.default, 'publish')
  assert.equal(action.inputs.preview.default, 'false')
})

test('declares the documented outputs', () => {
  assert.deepEqual(Object.keys(action.outputs).sort(), [
    'deleted-alias', 'deleted-rule-set', 'deployment-id', 'detached', 'index', 'rule-set-id', 'target-url',
  ])
})

test('is a composite action whose steps run in publish order', () => {
  assert.equal(action.runs.using, 'composite')
  const uses = action.runs.steps.map((s) => s.uses).filter(Boolean)
  assert.deepEqual(uses, [
    'actions/setup-node@v4',
    'bffless/deploy-proxy-rules@v1',
    'bffless/upload-artifact@v1',
  ])
  // The rule set must be synced BEFORE the bundle is deployed: upload-artifact attaches
  // it to the new alias by name, so the name has to exist by then.
  const order = action.runs.steps.map((s) => s.id ?? s.uses ?? s.name)
  assert.ok(order.indexOf('rules') < order.indexOf('upload'), 'sync must precede deploy')
})

test('every ${{ steps.X.outputs.Y }} names a step declared earlier', () => {
  const ids = new Set()
  const check = (text, where) => {
    for (const [, id] of String(text).matchAll(/\$\{\{\s*steps\.([\w-]+)\./g)) {
      assert.ok(ids.has(id), `${where} references steps.${id} which is not declared before it`)
    }
  }
  for (const step of action.runs.steps) {
    check(JSON.stringify(step), `step "${step.name ?? step.uses}"`)
    if (step.id) ids.add(step.id)
  }
  check(JSON.stringify(action.outputs), 'outputs')
})

test('the teardown step runs only in teardown mode; every other step (but Validate mode, setup-node and npm ci) runs only in publish mode', () => {
  const alwaysOn = new Set(['Validate mode', 'actions/setup-node@v4', 'Install action deps'])
  for (const step of action.runs.steps) {
    const label = step.name ?? step.uses
    if (alwaysOn.has(label)) {
      assert.equal(step.if, undefined, `"${label}" must not be gated on mode`)
      continue
    }
    if (step.id === 'teardown') {
      assert.equal(step.if, "inputs.mode == 'teardown'", `"${label}" must be gated on teardown mode`)
    } else {
      assert.equal(step.if, "inputs.mode == 'publish'", `"${label}" must be gated on publish mode`)
    }
  }
})

test('the teardown step calls scripts/teardown.mjs with the api key in the environment, never argv', () => {
  const step = action.runs.steps.find((s) => s.id === 'teardown')
  assert.ok(step, 'a step with id "teardown" must exist')
  assert.equal(step.env.BFFLESS_API_KEY, '${{ inputs.api-key }}')
  assert.doesNotMatch(step.run, /--api-key/)
  assert.match(step.run, /teardown\.mjs/)
  assert.match(step.run, />> "\$GITHUB_OUTPUT"/)
})

// An unrecognised `mode` must fail loudly rather than silently no-op every gated step.
const validateMode = action.runs.steps.find((s) => s.name === 'Validate mode')
const runValidateMode = (mode) => {
  try {
    execFileSync('bash', ['-c', validateMode.run], { env: { ...process.env, MODE: mode }, stdio: 'pipe' })
    return { failed: false, stdout: '' }
  } catch (e) {
    return { failed: true, stdout: String(e.stdout ?? '') }
  }
}

test('Validate mode is the first step, ungated, and accepts publish/teardown', () => {
  assert.ok(validateMode, 'a step named "Validate mode" must exist')
  assert.equal(action.runs.steps[0], validateMode, 'it must run before setup-node / npm ci')
  assert.equal(validateMode.if, undefined)
  assert.equal(runValidateMode('publish').failed, false)
  assert.equal(runValidateMode('teardown').failed, false)
})

test('Validate mode rejects anything else', () => {
  for (const bad of ['Teardown', 'PUBLISH', 'delete', '']) {
    const { failed, stdout } = runValidateMode(bad)
    assert.equal(failed, true, `mode "${bad}" should fail validation`)
    assert.match(stdout, /::error::input `mode` must be "publish" or "teardown"/)
  }
})

test('every ${{ inputs.X }} names a declared input', () => {
  const declared = new Set(Object.keys(action.inputs))
  for (const [, name] of JSON.stringify(action.runs).matchAll(/\$\{\{\s*inputs\.([\w-]+)\s*\}\}/g)) {
    assert.ok(declared.has(name), `inputs.${name} is referenced but not declared`)
  }
})

test('never interpolates an input straight into a run: script', () => {
  // Inputs reach shell steps through env:, so a value containing `"; rm -rf /` is data.
  for (const step of action.runs.steps) {
    if (!step.run) continue
    assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./, `step "${step.name}" interpolates an input into run:`)
  }
})

// The "Resolve inputs" step writes to $GITHUB_OUTPUT, which is line-oriented: a newline in
// an input value could forge extra key=value lines. Run the real script, not a paraphrase.
const cfg = action.runs.steps.find((s) => s.id === 'cfg')
const runCfg = (env) => {
  const out = join(mkdtempSync(join(tmpdir(), 'publish-workflow-cfg-')), 'out')
  const base = {
    ALIAS: 'hello', RULES: '', NAME: '', OUT: 'dist', WORKFLOWS: '.bffless/workflows',
    DESCRIPTION: '', TARGET_URL: '', BACKEND_URL: 'http://localhost:3000', REPOSITORY: 'bffless/workflow',
  }
  try {
    execFileSync('bash', ['-c', cfg.run], {
      env: { ...process.env, ...base, ...env, GITHUB_OUTPUT: out },
      stdio: 'pipe',
    })
  } catch (e) {
    return { failed: true, stdout: String(e.stdout ?? ''), file: existsSync(out) ? readFileSync(out, 'utf8') : '' }
  }
  return { failed: false, stdout: '', file: readFileSync(out, 'utf8') }
}

test('Resolve inputs writes the derived defaults, including the in-process target-url', () => {
  const { failed, file } = runCfg({ DESCRIPTION: 'A demo' })
  assert.equal(failed, false)
  assert.equal(
    file,
    'rules=.bffless/proxy-rules/hello\nname=hello\nindex=dist/.bffless/workflows/index.json\n' +
      'target-url=http://localhost:3000/public/bffless/workflow/alias/hello/dist\n',
  )
})

test('Resolve inputs computes the in-process target-url for a preview alias', () => {
  const { failed, file } = runCfg({ ALIAS: 'hello-pr-12' })
  assert.equal(failed, false)
  assert.match(file, /target-url=http:\/\/localhost:3000\/public\/bffless\/workflow\/alias\/hello-pr-12\/dist\n/)
})

test('Resolve inputs keeps an explicit target-url verbatim, never recomputing it', () => {
  const { failed, file } = runCfg({ TARGET_URL: 'https://hello.j5s.dev' })
  assert.equal(failed, false)
  assert.match(file, /target-url=https:\/\/hello\.j5s\.dev\n/)
})

test('Resolve inputs uses a nested path AS GIVEN for the in-process target-url, not its basename', () => {
  // bffless/upload-artifact zips with the given `path` as the prefix (src/zip.ts:
  // archive.directory(resolvedPath, buildPath)), so the bundle root on the alias is the
  // full path, not its last segment — out/bundle serves at .../out/bundle/, not .../bundle/.
  const { failed, file } = runCfg({ OUT: 'out/bundle' })
  assert.equal(failed, false)
  assert.match(file, /target-url=http:\/\/localhost:3000\/public\/bffless\/workflow\/alias\/hello\/out\/bundle\n/)
  assert.match(file, /index=out\/bundle\/\.bffless\/workflows\/index\.json\n/)
})

test('Resolve inputs strips a leading ./ and trailing / from path before composing target-url', () => {
  const { failed, file } = runCfg({ OUT: './dist/' })
  assert.equal(failed, false)
  assert.match(file, /target-url=http:\/\/localhost:3000\/public\/bffless\/workflow\/alias\/hello\/dist\n/)
})

test('Resolve inputs strips a trailing / from backend-url before composing target-url', () => {
  const { failed, file } = runCfg({ BACKEND_URL: 'http://localhost:3000/' })
  assert.equal(failed, false)
  assert.doesNotMatch(file, /\/\/public/)
  assert.match(file, /target-url=http:\/\/localhost:3000\/public\/bffless\/workflow\/alias\/hello\/dist\n/)
})

test('Resolve inputs rejects a newline in any guarded input', () => {
  for (const key of ['ALIAS', 'RULES', 'NAME', 'OUT', 'WORKFLOWS', 'DESCRIPTION', 'TARGET_URL', 'BACKEND_URL', 'REPOSITORY']) {
    const { failed, stdout, file } = runCfg({ [key]: 'evil\nindex=/etc/passwd' })
    assert.equal(failed, true, `${key} with a newline should fail the step`)
    assert.match(stdout, /::error::input `[a-z-]+` must not contain a newline/)
    assert.equal(file, '', `${key} must not have written any output`)
  }
})

test('the "Prepare the rule set" step reads the resolved target-url, not the raw input', () => {
  // inputs.target-url is blank whenever the default applies — the step must read the
  // step-computed value, or the forwarder would be pushed with an empty targetUrl.
  const step = action.runs.steps.find((s) => s.id === 'prepare')
  assert.equal(step.env.TARGET_URL, '${{ steps.cfg.outputs.target-url }}')
})
