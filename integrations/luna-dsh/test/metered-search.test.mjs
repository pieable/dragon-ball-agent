import test from 'node:test';import assert from 'node:assert/strict';import {runMeteredSearch} from '../metered-search.mjs';
test('incomplete charged search retains usage and provider evidence',async()=>{
 const record={};let saved;const failure=Object.assign(new Error('incomplete'),{code:'RESPONSE_INCOMPLETE',request_id:'request-1',usage:{input_tokens:123,output_tokens:5},web_search_calls:[{status:'completed'}],incomplete_details:{reason:'max_output_tokens'}});
 await assert.rejects(runMeteredSearch({query:'test'},{record,save:async r=>saved=structuredClone(r),search:async()=>{throw failure}}),e=>e.message.includes('123')&&e.message.includes('request-1')&&e.message.includes('max_output_tokens'));
 assert.equal(saved.auxiliary_usage[0].status,'failed');assert.equal(saved.auxiliary_usage[0].cost_known,true);assert.equal(saved.auxiliary_usage[0].web_search_calls,1);
});
test('network failure preserves unknown cost rather than claiming zero',async()=>{
 const record={};await assert.rejects(runMeteredSearch({},{record,save:async()=>{},search:async()=>{throw Object.assign(new Error('network'),{code:'NETWORK_ERROR'})}}));
 assert.equal(record.auxiliary_usage[0].usage,null);assert.equal(record.auxiliary_usage[0].web_search_calls,null);assert.equal(record.auxiliary_usage[0].cost_known,false);
});
