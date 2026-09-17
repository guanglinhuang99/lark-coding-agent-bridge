import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RiskRouter } from '../../../src/business/risk/router';
import { WeComRiskRouter } from '../../../src/wecom/risk/router';
import { RiskDirectClient } from '../../../src/business/risk/client';
import { RiskDirectClient as LegacyClient } from '../../../src/wecom/risk/client';
import { parseBusinessCommand } from '../../../src/business/commands';
import { parseWeComCommand } from '../../../src/wecom/commands';
import { readRiskRuntimeConfig, resolveRiskIntentModel } from '../../../src/business/risk/runtime';
import { collectRiskIntent } from '../../../src/business/risk/analyzer';
import type { AgentEvent, AgentRun } from '../../../src/agent/types';

function run(events: AgentEvent[]): AgentRun {
  return { runId: 'test', events: (async function* () { yield* events; })(),
    stop: vi.fn(async () => {}), waitForExit: vi.fn(async () => true) };
}
const json: AgentEvent = { type: 'final_text', content: JSON.stringify({
  account_query: '测试账户', action: 'subscription', amount_text: '1000万', market: 'secondary',
}) };

describe('shared business architecture', () => {
  it('legacy imports are aliases to the exact same implementations', () => {
    expect(WeComRiskRouter).toBe(RiskRouter);
    expect(LegacyClient).toBe(RiskDirectClient);
    expect(parseWeComCommand).toBe(parseBusinessCommand);
  });
  it('business modules never import either chat adapter or an IM SDK', () => {
    for (const file of readdirSync('src/business/risk').filter(file => file.endsWith('.ts'))) {
      const text = readFileSync(join('src/business/risk', file), 'utf8');
      expect(text, file).not.toMatch(/from\s+['"][^'"]*(?:\/wecom\/|\/bot\/|@wecom\/|@larksuite\/)/);
    }
  });
  it('keeps local stdio on the same core tool contract as remote MCP', () => {
    const source = readFileSync('src/business/risk/stdio_server.py', 'utf8');
    expect(source).toContain('create_unified_mcp(include_specialized_tools=False)');
    expect(source).not.toContain('include_specialized_tools=True');
  });
  it('channel presentation cannot write or replace business conversation state', () => {
    const source = readFileSync('src/wecom/risk/interaction.ts', 'utf8');
    expect(source).not.toMatch(/riskStates\.(?:setQuery|setPretrade|setConversation|delete|clearConversation)\(/);
    expect(source).not.toMatch(/executeQueryMessage|sendRouteResult|applyQueryContinuation/);
  });
  it('neutral runtime settings override legacy values while preserving the migration fallback', () => {
    const env = { RISK_MCP_URL: 'https://connect.example/risk/mcp/', WECOM_RISK_MCP_URL: 'https://legacy/mcp/' };
    const shared = readRiskRuntimeConfig({ env, rootDir: '/root', defaultStateDir: '/state' });
    const migrated = readRiskRuntimeConfig({ env, rootDir: '/root', defaultStateDir: '/state', legacyPrefix: 'WECOM' });
    expect(migrated).toEqual(shared);
    expect(shared).toMatchObject({ url: 'https://connect.example/risk/mcp/' });
    expect(readRiskRuntimeConfig({ env: { WECOM_RISK_MCP_URL: 'https://legacy/mcp/' }, rootDir: '/root',
      defaultStateDir: '/state', legacyPrefix: 'WECOM' }).url).toBe('https://legacy/mcp/');
  });
  it.each(['', '   '])('treats blank neutral settings as absent for legacy fallback: %j', blank => {
    const legacy = { WECOM_RISK_MCP_URL: 'https://legacy/mcp/', WECOM_RISK_MCP_AUTH: 'Key secret' };
    const options = { rootDir: '/root', defaultStateDir: '/state', legacyPrefix: 'WECOM' };
    const expected = readRiskRuntimeConfig({ ...options, env: legacy });
    expect(readRiskRuntimeConfig({ ...options, env: { ...legacy, RISK_MCP_URL: blank,
      RISK_MCP_AUTH: blank } })).toEqual(expected);
  });
  it('rejects nonblank invalid neutral configuration instead of using a valid legacy value', () => {
    expect(() => readRiskRuntimeConfig({ rootDir: '/root', defaultStateDir: '/state', legacyPrefix: 'WECOM',
      env: { RISK_MCP_POLL_INTERVAL_MS: 'bad', WECOM_RISK_MCP_POLL_INTERVAL_MS: '1000' } })).toThrow('RISK_MCP_POLL_INTERVAL_MS');
  });
  it('uses the same default intent model, with neutral overrides winning', () => {
    expect(resolveRiskIntentModel({})).toBe(resolveRiskIntentModel({}, 'WECOM'));
    expect(resolveRiskIntentModel({ RISK_INTENT_MODEL: 'shared', WECOM_RISK_INTENT_MODEL: 'old' }, 'WECOM')).toBe('shared');
  });
  it('selects remote HTTP or local stdio MCP explicitly', () => {
    const common = { rootDir: '/root', defaultStateDir: '/state' };
    expect(readRiskRuntimeConfig({ ...common, env: { RISK_MCP_URL: 'https://connect.example/mcp/' } }))
      .toMatchObject({ mode: 'local', url: 'https://connect.example/mcp/' });
    expect(readRiskRuntimeConfig({ ...common, env: {
      RISK_MCP_MODE: 'remote', RISK_MCP_URL: 'https://connect.example/mcp/',
    } })).toMatchObject({ mode: 'remote', url: 'https://connect.example/mcp/' });
    expect(readRiskRuntimeConfig({ ...common, env: {
      RISK_MCP_MODE: 'local', RISK_MCP_PYTHON: '/python', RISK_SERVICE_DIR: '/risk-service',
    } })).toMatchObject({ mode: 'local', pythonPath: '/python', serviceDir: '/risk-service' });
    expect(() => readRiskRuntimeConfig({ ...common, env: { RISK_MCP_MODE: 'automatic' } }))
      .toThrow('RISK_MCP_MODE');
  });
  it.each(['0', '-1', 'bad', '1.5'])('rejects invalid MCP poll configuration: %s', value => {
    expect(() => readRiskRuntimeConfig({ env: { RISK_MCP_POLL_INTERVAL_MS: value }, rootDir: '/r', defaultStateDir: '/s' }))
      .toThrow('RISK_MCP_POLL_INTERVAL_MS');
  });
});

describe('shared extraction safety', () => {
  it('accepts only a normal complete response', async () => {
    const handle = run([json, { type: 'done', terminationReason: 'normal' }]);
    expect(await collectRiskIntent(handle, { originalText: '测试账户申购1000万' })).toMatchObject({ action: 'subscription' });
    expect(handle.stop).not.toHaveBeenCalled();
  });
  it.each<AgentEvent[]>([
    [json],
    [json, { type: 'done', terminationReason: 'timeout' }],
    [json, { type: 'error', message: 'synthetic failure', terminationReason: 'failed' }],
    [{ type: 'tool_use', id: 'tool', name: 'shell', input: {} }, json, { type: 'done', terminationReason: 'normal' }],
  ])('rejects incomplete, failed, or tool-using extraction %#', async (...events) => {
    const handle = run(events);
    await expect(collectRiskIntent(handle, { originalText: 'test' })).rejects.toThrow();
    expect(handle.stop).toHaveBeenCalled();
  });
  it('does not parse an already cancelled run', async () => {
    const controller = new AbortController(); controller.abort();
    const handle = run([json, { type: 'done', terminationReason: 'normal' }]);
    await expect(collectRiskIntent(handle, { originalText: 'test', signal: controller.signal })).rejects.toThrow('interrupted');
    expect(handle.stop).toHaveBeenCalled();
  });
});
