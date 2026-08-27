import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

import { prepareRules } from '../scripts/prepare-rules.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const fixture = (name) => join(here, 'fixtures', name)
const tmp = () => join(mkdtempSync(join(tmpdir(), 'publish-workflow-')), 'rules')
const readYaml = (p) => parse(readFileSync(p, 'utf8'))

test('copies the set, renames it, writes the forwarder', async () => {
  const out = await prepareRules({
    rulesDir: fixture('hello'),
    alias: 'hello-pr-3',
    targetUrl: 'https://hello-pr-3.example.test',
    outDir: tmp(),
  })
  const ruleset = readYaml(`${out}/ruleset.yaml`)
  assert.equal(ruleset.name, 'hello-pr-3')
  assert.equal(ruleset.description, "The hello Workflow implementation's API.")

  const fwd = readYaml(`${out}/rules/_custom/forward/get.rule.yaml`)
  assert.deepEqual(fwd, {
    pathPattern: '/w/hello-pr-3/*',
    targetUrl: 'https://hello-pr-3.example.test',
    forwardCookies: true,
    order: 5,
    description: fwd.description,
  })
  assert.match(fwd.description, /bffless\/publish-workflow/)

  assert.ok(existsSync(`${out}/rules/echo/post/rule.yaml`))
})

test('leaves the source set untouched', async () => {
  const src = fixture('hello')
  await prepareRules({ rulesDir: src, alias: 'hello-pr-4', targetUrl: 'https://x.example.test', outDir: tmp() })
  assert.equal(readYaml(`${src}/ruleset.yaml`).name, 'hello')
  assert.equal(existsSync(`${src}/rules/_custom`), false)
})

test('refuses an authored forwarder (it is generated)', async () => {
  await assert.rejects(
    prepareRules({ rulesDir: fixture('with-forwarder'), alias: 'x', targetUrl: 'https://x', outDir: tmp() }),
    /rules\/_custom\/forward/,
  )
})

test('rejects a malformed alias', async () => {
  await assert.rejects(
    prepareRules({ rulesDir: fixture('hello'), alias: 'Hello_3', targetUrl: 'https://x', outDir: tmp() }),
    /alias/i,
  )
})

test('rejects a reserved alias', async () => {
  for (const alias of ['workflow', 'w', 'auth', '_bffless']) {
    await assert.rejects(
      prepareRules({ rulesDir: fixture('hello'), alias, targetUrl: 'https://x', outDir: tmp() }),
      /reserved/i,
      `expected ${alias} to be reserved`,
    )
  }
})

test('requires a target url', async () => {
  await assert.rejects(
    prepareRules({ rulesDir: fixture('hello'), alias: 'hello', targetUrl: '', outDir: tmp() }),
    /target-url/,
  )
})

test('fails when the rule set directory is not a rule set', async () => {
  await assert.rejects(
    prepareRules({ rulesDir: join(here, 'fixtures', 'nope'), alias: 'hello', targetUrl: 'https://x', outDir: tmp() }),
    /ruleset\.yaml/,
  )
})
