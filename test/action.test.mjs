import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

// actionlint (1.7.7) parses every file it is given as a *workflow*, so it cannot check a
// composite action.yml. These assertions are the stand-in: they hold the file to the
// contract the README documents and catch the typo actionlint would have caught —
// an expression naming a step id or an input that does not exist.
const action = parse(readFileSync(fileURLToPath(new URL('../action.yml', import.meta.url)), 'utf8'))

test('declares the documented inputs, with the documented defaults', () => {
  assert.deepEqual(Object.keys(action.inputs).sort(), [
    'alias', 'api-key', 'api-url', 'description', 'harness-alias', 'lint-version',
    'name', 'path', 'prune', 'repository', 'rules', 'target-url', 'workflows',
  ])
  for (const required of ['alias', 'api-url', 'api-key', 'repository', 'target-url']) {
    assert.equal(action.inputs[required].required, true, `${required} must be required`)
  }
  assert.equal(action.inputs.path.default, 'dist')
  assert.equal(action.inputs.workflows.default, '.bffless/workflows')
  assert.equal(action.inputs['harness-alias'].default, 'workflow')
  assert.equal(action.inputs.prune.default, 'true')
  // @bffless/workflow-lint is published at 1.0.0.
  assert.equal(action.inputs['lint-version'].default, '^1.0.0')
})

test('declares the documented outputs', () => {
  assert.deepEqual(Object.keys(action.outputs).sort(), ['deployment-id', 'index', 'rule-set-id'])
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
