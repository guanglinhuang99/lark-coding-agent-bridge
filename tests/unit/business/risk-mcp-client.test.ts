import { describe, expect, it, vi } from 'vitest';
import { RiskMcpClient } from '../../../src/business/risk/mcp-client';

function response(result: Record<string, unknown>) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'test', result }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

describe('risk MCP client', () => {
  it('calls the Connect MCP endpoint with authentication and no local process', async () => {
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: { name?: string } };
      if (body.method === 'tools/list') return response({ tools: [{ name: 'list_pretrade_products' }] });
      return response({ structuredContent: { products: ['产品A'] } });
    });
    const client = new RiskMcpClient({
      url: 'https://connect.example/risk-service/mcp/', authorization: 'Key test', fetch: request,
    });

    await client.prewarm();
    await expect(client.listProducts()).resolves.toEqual(['产品A']);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![0]).toBe('https://connect.example/risk-service/mcp/');
    expect(new Headers(request.mock.calls[1]![1]?.headers).get('authorization')).toBe('Key test');
    expect(JSON.parse(String(request.mock.calls[1]![1]?.body))).toMatchObject({
      method: 'tools/call', params: { name: 'list_pretrade_products', arguments: {} },
    });
    expect(client.runtimeStatus()).toEqual({ ready: true, endpoint: 'https://connect.example/risk-service/mcp/' });
  });

  it('submits and polls pretrade calculations through MCP', async () => {
    const progress = vi.fn();
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { params: { name: string } };
      if (body.params.name === 'calculate_pretrade_limits') {
        return response({ structuredContent: { run_id: 'run-1', status: 'running' } });
      }
      return response({ structuredContent: {
        run_id: 'run-1', status: 'success', progress: '完成', result: { issues: [], product: '产品A' },
      } });
    });
    const client = new RiskMcpClient({ url: 'https://connect.example/mcp/', fetch: request, pollIntervalMs: 1 });

    await expect(client.calculatePretrade('产品A', { type: 'subscription', amount: 1 }, progress))
      .resolves.toMatchObject({ status: 'success', product: '产品A', issues: [] });
    expect(progress).toHaveBeenCalledWith('完成');
    expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toMatchObject({
      params: { name: 'calculate_pretrade_limits', arguments: {
        product: '产品A', actions: [{ type: 'subscription', amount: 1 }],
      } },
    });
  });

  it('does not expose credentials in runtime status or network failures', async () => {
    const client = new RiskMcpClient({
      url: 'https://user:password@connect.example/mcp/?token=secret', authorization: 'Key secret',
      fetch: vi.fn<typeof fetch>(async () => { throw new Error('Key secret'); }),
    });
    await expect(client.getCredit('公司甲')).rejects.toMatchObject({
      code: 'mcp-network', message: 'risk-service MCP 暂时不可用',
    });
    expect(JSON.stringify(client.runtimeStatus())).not.toMatch(/secret|password|user/);
  });
});
