import test from 'node:test';import assert from 'node:assert/strict';
import {BridgeState} from '../plugin-state.mjs';import {withActiveParent,queueNotification} from '../coordination-lifecycle.mjs';
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve}};
test('child admission after parent cancellation is rejected before create',async()=>{
 const state=new BridgeState('unused'),parent={agent_id:'parent',state:'running'};const preflight=gate();let created=false;
 const spawn=(async()=>{await preflight.promise;return withActiveParent(state,parent,async()=>{created=true})})();
 await state.exclusive(parent.agent_id,async()=>{parent.state='cancelled'});preflight.resolve();await assert.rejects(spawn,/no longer/);assert.equal(created,false);
});
test('parent close waits for already admitted child, then observes it',async()=>{
 const state=new BridgeState('unused'),parent={agent_id:'parent',state:'running'},inside=gate(),release=gate();let child=false,seen=false;
 const spawn=withActiveParent(state,parent,async()=>{inside.resolve();await release.promise;child=true});await inside.promise;
 const close=state.exclusive(parent.agent_id,async()=>{parent.state='closed';seen=child});release.resolve();await Promise.all([spawn,close]);assert.equal(seen,true);
});
test('parent cancellation and child notification cannot form monitor lock cycle',async()=>{
 const state=new BridgeState('unused'),parent={agent_id:'parent',state:'running'},pending=new Map(),deliveryStarted=gate(),releaseDelivery=gate();let woke=false;
 const monitor=(async()=>{queueNotification(pending,'child:1',async()=>{deliveryStarted.resolve();await releaseDelivery.promise;await state.exclusive(parent.agent_id,async()=>{if(parent.state==='running')woke=true});},e=>{throw e});})();
 await deliveryStarted.promise;
 await state.exclusive(parent.agent_id,async()=>{parent.state='cancelled';releaseDelivery.resolve();await monitor});
 await Promise.all(pending.values());assert.equal(woke,false);assert.equal(pending.size,0);
});
