// An offline Responses fixture. It exercises the real Codex harness, never a paid API.
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');

async function mockProvider(options = {}) {
  const seen = [];
  const events = new EventEmitter();
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'desk-test-model' }, ...(options.images ? [{id:'gpt-image-1'}] : [])] })); return; }
    if (options.images && req.url === '/v1/images/generations') { for await (const _chunk of req) {} res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='}]}));return; }
    if (req.url !== '/v1/responses') { res.writeHead(404); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let buffer = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'zstd') buffer = zlib.zstdDecompressSync(buffer);
    const body = JSON.parse(buffer.toString());
    seen.push(body);
    events.emit('request', body);
    const messages = JSON.stringify(body.input);
    const lastUser = [...(body.input || [])].reverse().find((i) => i.role === 'user');
    const userText = JSON.stringify(lastUser || '');
    const outputs = [];
    const toolOutputs = (body.input || []).filter((i) => /tool_call_output|function_call_output/.test(i.type));
    if (userText.includes('offline-tool-probe') && !toolOutputs.length) {
      const tools = [...(body.tools || []), ...(body.input || []).filter(i => i.type === 'additional_tools').flatMap(i => i.tools || [])].flatMap((t) => t.type === 'namespace' ? t.tools.map((sub) => ({ ...sub, namespace: t.name })) : [t]);
      const tool = tools.find((t) => /^(exec_command|shell_command|shell)$/.test(t.name));
      const codeMode = tools.find((t) => t.type === 'custom' && t.name === 'exec');
      if (codeMode) {
        const cmd = process.platform === 'win32' ? 'Set-Content -LiteralPath desk-probe.txt -Value desk-real-tool-ok -NoNewline; Get-Content desk-probe.txt' : "printf 'desk-real-tool-ok' > desk-probe.txt; cat desk-probe.txt";
        outputs.push({ type: 'custom_tool_call', id: 'ctc_' + randomUUID(), call_id: 'call_' + randomUUID(), name: 'exec',
          ...(codeMode.namespace ? { namespace: codeMode.namespace } : {}),
          input: `text(await tools.exec_command({cmd:${JSON.stringify(cmd)},max_output_tokens:200}));`, status: 'completed' });
      } else if (tool) {
        const command = process.platform === 'win32' ? "Set-Content -LiteralPath desk-probe.txt -Value desk-real-tool-ok -NoNewline; Write-Output desk-real-tool-ok" : "printf 'desk-real-tool-ok' > desk-probe.txt; printf 'desk-real-tool-ok'";
        const args = tool.name === 'shell' ? { command: process.platform === 'win32' ? ['powershell.exe','-NoProfile','-Command',command] : ['/bin/sh', '-c', command] } : { cmd: command, command, yield_time_ms: 1000, max_output_tokens: 200 };
        if (userText.includes('offline-approval-probe')) Object.assign(args, { sandbox_permissions: 'require_escalated', justification: '在独立测试目录中验证审批交互' });
        if (tool.name === 'shell_command') { delete args.cmd; delete args.yield_time_ms; }
        outputs.push({ type: 'function_call', id: 'fc_' + randomUUID(), call_id: 'call_' + randomUUID(), name: tool.name,
          ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: JSON.stringify(args), status: 'completed' });
      }
    }
    if (!outputs.length) outputs.push({ type: 'message', id: 'msg_' + randomUUID(), role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: userText.includes('offline-tool-probe') ? '本地工具已完成。\n\n```text\ndesk-real-tool-ok\n```' : '连接测试完成。', annotations: [] }], phase: 'final_answer' });
    const response = { id: 'resp_' + randomUUID(), object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: body.model, output: [] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('response.created', { response });
    if (messages.includes('offline-slow-probe')) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 10000);
        res.once('close', () => { clearTimeout(timer); resolve(); });
      });
      if (res.destroyed) return;
    }
    let sequence = 0;
    for (const item of outputs) {
      const index = sequence++;
      event('response.output_item.added', { output_index: index, item: { ...item, ...(item.type === 'message' ? { content: [] } : { arguments: '' }) } });
      if (item.type === 'message') {
        event('response.content_part.added', { item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        event('response.output_text.delta', { item_id: item.id, output_index: index, content_index: 0, delta: item.content[0].text });
        event('response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, text: item.content[0].text });
      } else if (item.type === 'function_call') event('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments });
      event('response.output_item.done', { output_index: index, item });
    }
    event('response.completed', { response: { ...response, status: 'completed', output: outputs,
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1`, seen,
    waitForRequest: (predicate) => new Promise((resolve, reject) => {
      if (seen.some(predicate)) return resolve();
      const listener = (body) => { if (predicate(body)) { clearTimeout(timer); events.off('request', listener); resolve(); } };
      const timer = setTimeout(() => { events.off('request', listener); reject(new Error('fixture did not receive expected request')); }, 5000);
      events.on('request', listener);
    }) };
}
module.exports = { mockProvider };
