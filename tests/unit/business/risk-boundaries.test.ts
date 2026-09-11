import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { RiskRouter } from '../../../src/business/risk/router';
import { WeComRiskRouter } from '../../../src/wecom/risk/router';
import { RiskDirectClient } from '../../../src/business/risk/client';
import { RiskDirectClient as LegacyClient } from '../../../src/wecom/risk/client';
import { parseBusinessCommand } from '../../../src/business/commands';
import { parseWeComCommand } from '../../../src/wecom/commands';
import { readRiskRuntimeConfig, resolveRiskIntentModel, resolveRiskBridgePath } from '../../../src/business/risk/runtime';
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
  it('channel presentation cannot write or replace business conversation state', () => {
    const source = readFileSync('src/wecom/risk/interaction.ts', 'utf8');
    expect(source).not.toMatch(/riskStates\.(?:setQuery|setPretrade|setConversation|delete|clearConversation)\(/);
    expect(source).not.toMatch(/executeQueryMessage|sendRouteResult|applyQueryContinuation/);
  });
  it('neutral runtime settings override legacy values while preserving the migration fallback', () => {
    const env = { RISK_PYTHON: '/common/python', WECOM_RISK_PYTHON: '/legacy/python', RISK_DIRECT_WORKERS: '6' };
    const shared = readRiskRuntimeConfig({ env, rootDir: '/root', defaultStateDir: '/state' });
    const migrated = readRiskRuntimeConfig({ env, rootDir: '/root', defaultStateDir: '/state', legacyPrefix: 'WECOM' });
    expect(migrated).toEqual(shared);
    expect(shared).toMatchObject({ pythonPath: '/common/python', workers: 6,
      bridgePath: resolve('/root', 'src/business/risk/direct_bridge.py') });
    expect(readRiskRuntimeConfig({ env: { WECOM_RISK_PYTHON: '/legacy/python' }, rootDir: '/root',
      defaultStateDir: '/state', legacyPrefix: 'WECOM' }).pythonPath).toBe('/legacy/python');
  });
  it('finds the packaged Python bridge next to the loaded bundle, not the caller cwd', () => {
    const packaged = resolve('/release/dist/risk/direct_bridge.py');
    const moduleUrl = pathToFileURL(resolve('/release/dist/cli.js')).href;
    expect(resolveRiskBridgePath('/unrelated/cwd', moduleUrl, path => path === packaged)).toBe(packaged);
    expect(resolveRiskBridgePath('/checkout', moduleUrl, () => false))
      .toBe(resolve('/checkout/src/business/risk/direct_bridge.py'));
    expect(readRiskRuntimeConfig({ env: { RISK_BRIDGE_PATH: '/explicit/bridge.py' }, rootDir: '/checkout',
      defaultStateDir: '/state' }).bridgePath).toBe(resolve('/explicit/bridge.py'));
  });
  it('uses the same default intent model, with neutral overrides winning', () => {
    expect(resolveRiskIntentModel({})).toBe(resolveRiskIntentModel({}, 'WECOM'));
    expect(resolveRiskIntentModel({ RISK_INTENT_MODEL: 'shared', WECOM_RISK_INTENT_MODEL: 'old' }, 'WECOM')).toBe('shared');
  });
  it.each(['0', '-1', 'bad', '1.5'])('rejects invalid shared worker configuration: %s', value => {
    expect(() => readRiskRuntimeConfig({ env: { RISK_DIRECT_WORKERS: value }, rootDir: '/r', defaultStateDir: '/s' }))
      .toThrow('RISK_DIRECT_WORKERS');
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
