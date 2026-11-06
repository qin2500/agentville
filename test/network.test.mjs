/** Network fingerprinting and the work Wi-Fi mark, with an injected reader: never the real network. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createNetwork, readNetwork } from '../server/network.mjs'

test('mark and unmark the current network; offline is never work', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-net-'))
  let cur = { id: 'gw:aa:bb:cc:dd:ee:ff', gateway: '10.0.0.1' }, t = 0
  const net = createNetwork({ dataDir, read: async () => cur, now: () => (t += 10e3) })
  try {
    assert.deepEqual((await net.status()).current, { id: 'gw:aa:bb:cc:dd:ee:ff', gateway: '10.0.0.1', work: false })
    assert.equal((await net.mark({ work: true })).current.work, true)
    assert.equal(await net.onWork(), true)
    assert.equal(fs.statSync(path.join(dataDir, 'networks.json')).mode & 0o777, 0o600)
    cur = { id: 'gw:11:22:33:44:55:66', gateway: '192.168.1.1' } // somewhere else
    assert.equal(await net.onWork(), false)
    cur = { id: null } // offline
    assert.equal(await net.onWork(), false)
    await assert.rejects(net.mark({ work: true }), /Can't tell which network/)
    cur = { id: 'gw:aa:bb:cc:dd:ee:ff', gateway: '10.0.0.1' }
    assert.equal((await net.mark({ work: false })).current.work, false)
    assert.deepEqual((await net.status()).work, [])
    await assert.rejects(net.mark({ work: 1 }), /work must be true or false/)
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }) }
})

test('under test, readNetwork never looks at the real network', async () => {
  const saved = { v: process.env.AGENTVILLE_TEST, n: process.env.AGENTVILLE_NETWORK_ID }
  try {
    delete process.env.AGENTVILLE_NETWORK_ID; process.env.AGENTVILLE_TEST = '1'
    assert.deepEqual(await readNetwork(), { id: null })
    process.env.AGENTVILLE_NETWORK_ID = 'gw:01:02:03:04:05:06'
    assert.equal((await readNetwork()).id, 'gw:01:02:03:04:05:06')
  } finally {
    if (saved.v === undefined) delete process.env.AGENTVILLE_TEST; else process.env.AGENTVILLE_TEST = saved.v
    if (saved.n === undefined) delete process.env.AGENTVILLE_NETWORK_ID; else process.env.AGENTVILLE_NETWORK_ID = saved.n
  }
})
