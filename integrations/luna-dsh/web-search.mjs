// Official contracts: https://developers.openai.com/api/docs/guides/tools-web-search
// https://developers.openai.com/api/docs/models/gpt-6-luna
// Each invocation is an additional billable Responses request, including model
// tokens and hosted web-search tool charges; usage below is not a dollar quote.
export class WebSearchError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'WebSearchError'; this.code = code; Object.assign(this, details); }
}

export async function searchWeb({ query, effort = 'medium', signal } = {}, {
  apiKey = process.env.LUNA_OPENAI_API_KEY, fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new WebSearchError('INVALID_QUERY', 'query must be nonempty text');
  if (!['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new WebSearchError('INVALID_EFFORT', 'Unsupported reasoning effort');
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new WebSearchError('MISSING_CREDENTIAL', 'LUNA_OPENAI_API_KEY is required');
  const redact = value => String(value).split(apiKey).join('[REDACTED]');
  const safe = value => value === undefined ? undefined : JSON.parse(redact(JSON.stringify(value)));
  signal?.throwIfAborted();
  let response, body;
  try {
    response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6-luna', input: query, reasoning: { effort }, store: false,
        tools: [{ type: 'web_search' }], tool_choice: 'required', include: ['web_search_call.action.sources'] }),
    });
    body = redact(await response.text());
  } catch (error) {
    throw new WebSearchError(signal?.aborted ? 'ABORTED' : 'NETWORK_ERROR', redact(error.message || String(error)));
  }
  const request_id = redact(response.headers?.get('x-request-id') || '');
  if (!response.ok) throw new WebSearchError('HTTP_ERROR', `OpenAI HTTP ${response.status}: ${body}`, { status: response.status, response_body: body, request_id });
  let data;
  try { data = JSON.parse(body); } catch { throw new WebSearchError('INVALID_RESPONSE', 'OpenAI returned non-JSON response', { response_body: body, request_id }); }
  const output = Array.isArray(data.output) ? data.output : [];
  const calls = output.filter(item => item.type === 'web_search_call');
  const details = { response_id: data.id, request_id, usage: safe(data.usage), web_search_calls: safe(calls) };
  if (data.status !== 'completed') throw new WebSearchError('RESPONSE_INCOMPLETE', `OpenAI response status: ${String(data.status)}`, { ...details, error: safe(data.error), incomplete_details: safe(data.incomplete_details) });
  if (!calls.some(item => item.status === 'completed')) throw new WebSearchError('SEARCH_NOT_EXECUTED', 'No completed web_search_call in response', details);
  const texts = [], citations = [];
  for (const item of output) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content.type !== 'output_text') continue;
      const text_index = texts.length;
      texts.push(content.text || '');
      for (const annotation of content.annotations || []) if (annotation.type === 'url_citation') citations.push({ ...annotation, text_index });
    }
  }
  const sources = calls.flatMap(call => (call.action?.sources || []).map(source => ({ ...source, call_id: call.id })));
  return { ...details, model: data.model || 'gpt-6-luna', text: texts.join('\n'), text_parts: texts, citations, sources,
    urls: [...new Set([...citations, ...sources].map(item => item.url).filter(Boolean))],
    metering: { additional_api_request: true, hosted_search_calls: calls.length, completed_search_calls: calls.filter(c => c.status === 'completed').length, includes_model_tokens_and_tool_charges: true } };
}
