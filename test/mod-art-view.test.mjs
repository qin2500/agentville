import test from 'node:test'
import assert from 'node:assert/strict'
import { artView, artViews } from '../web/src/engine/mod/art-view.js'

const CANARY = 'CANARY-7f3a'
const obj = () => ({
  id: 'o1', kind: 'building', model: 'house', tx: 3, ty: 4, w: 2, h: 2, z: 0, walk: false, project: 'p', styleKey: 's', variant: 1,
  door: { tx: 3, ty: 5, face: 'x', agentId: CANARY }, rank: 'M', lot: 'a', crown: true, dir: 'x', len: 3,
  anchors: { sit: [{ id: 'a1', tx: 1, ty: 2, serverId: CANARY }] },
  data: { item: CANARY, agentId: CANARY }, agentId: CANARY, item: CANARY, serverId: CANARY, extra: CANARY,
})

test('artView leaks no server ids', () => {
  const v = artView(obj())
  assert.ok(!JSON.stringify(v).includes(CANARY))
  for (const k of ['data', 'agentId', 'item', 'serverId', 'extra']) assert.ok(!(k in v))
})
test('artView keeps allow-listed fields', () => {
  const v = artView(obj())
  assert.equal(v.id, 'o1'); assert.equal(v.tx, 3); assert.equal(v.door.face, 'x'); assert.equal(v.anchors.sit[0].tx, 1)
  assert.equal(v.crown, true); assert.equal(v.len, 3)
})
test('artView is frozen, deep, and a copy', () => {
  const o = obj(), v = artView(o)
  assert.ok(Object.isFrozen(v) && Object.isFrozen(v.door) && Object.isFrozen(v.anchors.sit) && Object.isFrozen(v.anchors.sit[0]))
  assert.notEqual(v.door, o.door)
  o.door.tx = 99
  assert.equal(v.door.tx, 3)
})
test('artViews batches', () => {
  const vs = artViews([obj(), obj()])
  assert.equal(vs.length, 2)
  assert.ok(!JSON.stringify(vs).includes(CANARY))
  assert.deepEqual(artViews(null), [])
})
