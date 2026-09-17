import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'notifications/initialized') return;
  const result = request.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
    : request.method === 'tools/list'
      ? { tools: [{ name: 'get_entity_credit' }] }
      : { structuredContent: { entity: request.params?.arguments?.entity } };
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
});
