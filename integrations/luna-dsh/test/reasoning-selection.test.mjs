import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEffort,selectionFor} from '../reasoning-selection.mjs';
test('effort aliases normalize and invalid values fail before selection',()=>{
  assert.equal(normalizeEffort('none'),'off');
  for(const value of [undefined,'ultra','HIGH',null])assert.throws(()=>normalizeEffort(value));
});
test('new sessions retain builtin route and legacy sessions retain original provider',()=>{
  assert.deepEqual(selectionFor({provider:'openai',reasoning_effort:'low'},'high'),{provider:'openai',model:'gpt-6-luna',reasoningEffort:'high'});
  assert.equal(selectionFor({reasoning_effort:'medium'}).provider,'luna-api');
});
