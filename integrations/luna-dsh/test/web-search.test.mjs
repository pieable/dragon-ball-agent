import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWeb } from '../web-search.mjs';
const apiKey = 'fake-only-secret';
const payload = () => ({ id: 'resp_1', status: 'completed', usage: { input_tokens: 31, output_tokens: 42 }, output: [
  { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url: 'https://example.org/source' }] } },
  { type: 'message', content: [{ type: 'output_text', text: '带来源正文', annotations: [{ type: 'url_citation', url: 'https://example.org/cited', title: '出处', start_index: 0, end_index: 5 }] }] },
] });
test('forces real hosted search and preserves sources, citations and usage', async () => {
  const controller = new AbortController();
  const result = await searchWeb({ query: '研究主题', effort: 'high', signal: controller.signal }, { apiKey, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.signal, controller.signal);
    assert.equal(options.redirect, 'error');
    const b = JSON.parse(options.body);
    assert.equal(b.model, 'gpt-6-luna'); assert.equal(b.reasoning.effort, 'high');
    assert.equal(b.tool_choice, 'required'); assert.deepEqual(b.tools, [{ type: 'web_search' }]);
    assert.deepEqual(b.include, ['web_search_call.action.sources']);
    return new Response(JSON.stringify(payload()));
  } });
  assert.equal(result.text, '带来源正文'); assert.equal(result.sources[0].call_id, 'ws_1');
  assert.equal(result.citations[0].text_index, 0); assert.equal(result.usage.input_tokens, 31);
  assert.equal(result.urls.length, 2); assert.equal(result.metering.additional_api_request, true);
});
test('generated prose without successful hosted call cannot pass', async () => {
  for (const status of [null, 'failed', 'in_progress']) {
    const p = payload(); if (status === null) p.output.shift(); else p.output[0].status = status;
    await assert.rejects(searchWeb({ query: 'q' }, { apiKey, fetchImpl: async () => new Response(JSON.stringify(p)) }), { code: 'SEARCH_NOT_EXECUTED' });
  }
});
test('HTTP diagnostics preserve error body/status/request id but redact credentials', async () => {
  await assert.rejects(searchWeb({ query: 'q' }, { apiKey, fetchImpl: async () => new Response(`invalid key ${apiKey}`, { status: 401, headers: { 'x-request-id': 'req_test' } }) }), e => e.status === 401 && e.request_id === 'req_test' && e.response_body === 'invalid key [REDACTED]' && !JSON.stringify(e).includes(apiKey));
});
test('incomplete responses retain usage; malformed JSON fails', async () => {
  const p = payload(); p.status = 'incomplete'; p.incomplete_details = { reason: 'max_output_tokens' };
  await assert.rejects(searchWeb({ query: 'q' }, { apiKey, fetchImpl: async () => new Response(JSON.stringify(p)) }), e => e.code === 'RESPONSE_INCOMPLETE' && e.usage.output_tokens === 42);
  await assert.rejects(searchWeb({ query: 'q' }, { apiKey, fetchImpl: async () => new Response('invalid') }), { code: 'INVALID_RESPONSE' });
});
test('cancellation propagates and network diagnostic cannot leak key', async () => {
  const c = new AbortController();
  await assert.rejects(searchWeb({ query: 'q', signal: c.signal }, { apiKey, fetchImpl: async () => { c.abort(); throw new Error('aborted ' + apiKey); } }), e => e.code === 'ABORTED' && !e.message.includes(apiKey));
  await assert.rejects(searchWeb({ query: 'q' }, { apiKey, fetchImpl: async () => { throw new Error('network ' + apiKey); } }), e => e.code === 'NETWORK_ERROR' && !e.message.includes(apiKey));
});
