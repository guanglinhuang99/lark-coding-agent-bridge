import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RiskMcpClient } from '../../../src/business/risk/mcp-client';
import { StdioMcpSession } from '../../../src/business/risk/stdio-mcp';

describe('local stdio risk MCP', () => {
  it('initializes MCP over stdin and reuses the child for tool calls', async () => {
    const session = new StdioMcpSession({
      pythonPath: process.execPath,
      launcherPath: resolve('tests/fixtures/risk-stdio-mcp.mjs'),
      serviceDir: process.cwd(),
      timeoutMs: 2_000,
    });
    const client = new RiskMcpClient({
      endpointLabel: 'local-stdio',
      requestHandler: (method, params) => session.request(method, params),
      closeHandler: () => session.close(),
    });

    await client.prewarm();
    await expect(client.getCredit('公司甲')).resolves.toEqual({ entity: '公司甲' });
    expect(client.runtimeStatus()).toEqual({ ready: true, endpoint: 'local-stdio' });
    await client.close();
    expect(client.runtimeStatus()).toEqual({ ready: false });
  });
});
