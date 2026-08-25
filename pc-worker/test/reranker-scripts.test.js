import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptsRoot = fileURLToPath(new URL('../scripts/', import.meta.url))
const compose = fs.readFileSync(fileURLToPath(new URL('../../docker-compose.pc-reranker.yml', import.meta.url)), 'utf8')

function script(name) {
  return fs.readFileSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), 'utf8')
}

test('reranker model scripts pin every required file and never regenerate a trusted manifest', () => {
  const prepare = script('reranker-prepare-model.ps1')
  const start = script('reranker-start.ps1')
  for (const source of [prepare, start]) {
    assert.match(source, /expectedManifestSha256/u)
    assert.match(source, /Get-FileHash/u)
    for (const hash of [
      '13DCD6C31D9FEC9D1D8E158702072F62D7FA7D312A64B9FE057BEC9A08CFE41A',
      'D9E3E081FAFF1EEFB84019509B2F5558FD74C1A05A2C7DB22F74174FCEDB5286',
      'CFC8146ABE2A0488E9E2A0C56DE7952F7C11AB059ECA145A0A727AFCE0DB2865',
      '8C785ABEBEA9AE3257B61681B4E6FD8365CEAFDE980C21970D001E834CF10835',
      '69564B696052886ED0AC63FA393E928384E0F8CAADA38C1F4864A9BFBF379C15',
      '7E4C1CC848840AECCDD763458C18DD525EB0F795C992E00EBE9C28554E7DB2D4'
    ]) assert.match(source, new RegExp(hash, 'u'))
  }
  assert.match(prepare, /refusing to overwrite or regenerate/u)
  assert.match(start, /Invoke-RestMethod/u)
  assert.match(start, /model_type/u)
})

test('reranker scripts and compose keep runtime data on D and isolate explicit startup', () => {
  for (const name of ['reranker-start.ps1', 'reranker-stop.ps1', 'reranker-logs.ps1']) {
    const source = script(name)
    assert.match(source, /(?:expectedComposeFile|Resolve-TrustedComposeFile)/u)
    assert.match(source, /ReparsePoint/u)
    assert.match(source, /docker-compose\.pc-reranker\.yml/u)
  }
  assert.match(compose, /profiles:\s*\r?\n\s+- reranker/u)
  assert.match(compose, /D:\/PRManagerAI\/models/u)
  assert.match(compose, /D:\/PRManagerAI\/cache/u)
  assert.match(compose, /served-model-name/u)
  assert.match(compose, /restart: ["']?no/u)
})

test('reranker compose uses only supported TEI 1.9 length controls', () => {
  assert.doesNotMatch(compose, /--max-input-length/u)
  assert.match(compose, /--max-batch-tokens\s*\r?\n\s*-\s*["']?5120/u)
  assert.match(compose, /--auto-truncate/u)
})

test('reranker compose bypasses the TEI cuda-entrypoint for fixed RTX 5080 CUDA 12.0', () => {
  assert.match(compose, /entrypoint:\s*\r?\n\s*-\s*\/usr\/local\/bin\/text-embeddings-router-120/u)
  assert.doesNotMatch(compose, /entrypoint:\s*(?:\r?\n\s*-\s*)?\/usr\/local\/bin\/cuda-entrypoint(?:\s|$)/u)
})
