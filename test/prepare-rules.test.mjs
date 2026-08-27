import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

  const { description, ...fwd } = readYaml(`${out}/rules/_custom/forward/get.rule.yaml`)
  assert.deepEqual(fwd, {
    pathPattern: '/w/hello-pr-3/*',
    targetUrl: 'https://hello-pr-3.example.test',
    forwardCookies: true,
    order: 5,
  })
  assert.match(description, /bffless\/publish-workflow/)
  assert.match(description, /hello-pr-3/)

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

test('rejects a target url that is not an absolute http(s) URL', async () => {
  for (const targetUrl of ['hello.example.test', '/w/hello', 'ftp://hello.example.test', 'javascript:alert(1)']) {
    await assert.rejects(
      prepareRules({ rulesDir: fixture('hello'), alias: 'hello', targetUrl, outDir: tmp() }),
      /target-url/,
      `expected ${targetUrl} to be rejected`,
    )
  }
})

test('accepts an http target url', async () => {
  const out = await prepareRules({
    rulesDir: fixture('hello'),
    alias: 'hello',
    targetUrl: 'http://localhost:5173',
    outDir: tmp(),
  })
  assert.equal(readYaml(`${out}/rules/_custom/forward/get.rule.yaml`).targetUrl, 'http://localhost:5173')
})

test('a re-run replaces the staged set instead of merging into it', async () => {
  const outDir = tmp()
  const first = await prepareRules({
    rulesDir: fixture('hello'),
    alias: 'hello',
    targetUrl: 'https://hello.example.test',
    outDir,
  })
  // A stale artefact from an earlier run of a *different* set must not survive.
  writeFileSync(join(first, 'rules', 'stale.rule.yaml'), 'pathPattern: /stale\n')
  await prepareRules({
    rulesDir: fixture('hello'),
    alias: 'hello',
    targetUrl: 'https://hello.example.test',
    outDir,
  })
  assert.equal(existsSync(join(outDir, 'rules', 'stale.rule.yaml')), false)
  assert.ok(existsSync(join(outDir, 'rules', '_custom', 'forward', 'get.rule.yaml')))
})

test('refuses to stage into the rule set directory itself', async () => {
  // rmSync(outDir) runs before the copy, so an outDir equal to (or containing, or contained
  // by) rulesDir would delete the source out from under the run. Run against a COPY of the
  // fixture: if this guard ever regresses, the regression eats the copy, not the checkout.
  const rulesDir = join(tmp(), 'hello')
  cpSync(fixture('hello'), rulesDir, { recursive: true })

  for (const outDir of [rulesDir, join(rulesDir, 'staged'), dirname(rulesDir)]) {
    await assert.rejects(
      prepareRules({ rulesDir, alias: 'hello', targetUrl: 'https://x.example.test', outDir }),
      /--out/,
      `expected outDir ${outDir} to be refused`,
    )
  }
  assert.ok(existsSync(join(rulesDir, 'ruleset.yaml')), 'the source set must survive')
})

test('requires an out directory', async () => {
  await assert.rejects(
    prepareRules({ rulesDir: fixture('hello'), alias: 'hello', targetUrl: 'https://x.example.test', outDir: '' }),
    /--out is required/,
  )
})

test('fails when the rule set directory is not a rule set', async () => {
  await assert.rejects(
    prepareRules({ rulesDir: join(here, 'fixtures', 'nope'), alias: 'hello', targetUrl: 'https://x', outDir: tmp() }),
    /ruleset\.yaml/,
  )
})
