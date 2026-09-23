import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  const req = JSON.parse(line);
  if (!Object.hasOwn(req, 'id')) continue;
  const result = req.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : req.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Echo fixture', inputSchema: { type: 'object', properties: {} } }] }
    : req.method === 'tools/call' ? { content: [{ type: 'text', text: process.env.MCP_TEST_VALUE || 'stdio-result' }] }
    : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
}
