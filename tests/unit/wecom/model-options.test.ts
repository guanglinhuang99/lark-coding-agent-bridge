import { describe, expect, it } from 'vitest';
import { effectiveModel, setConversationModel } from '../../../src/wecom/agent-preferences';
import { readWeComModelAllowlist, weComModelOptions } from '../../../src/wecom/model-options';

describe('WeCom model options', () => {
  it('always keeps the startup model available after switching away', () => {
    const options = weComModelOptions({
      startupModel: 'gpt-5.6-luna',
      currentModel: 'gpt-5-codex',
    });

    expect(options.map((option) => option.value)).toEqual(['gpt-5-codex', 'gpt-5.6-luna']);
    expect(options[0]?.label).toContain('当前');
    expect(options[1]?.label).toContain('启动默认');
  });

  it('only adds extra models from an explicit allowlist and deduplicates them', () => {
    const options = weComModelOptions({
      startupModel: 'gpt-5.6-luna',
      currentModel: 'gpt-5.6-luna',
      configuredModels: ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-sol'],
    });

    expect(options.map((option) => option.value)).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol']);
  });

  it('parses comma-delimited configured models', () => {
    expect(readWeComModelAllowlist(' gpt-5.6-sol，gpt-5.6-luna, gpt-5.6-sol ')).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-luna',
    ]);
  });

  it('keeps the startup model recoverable across a switch and switch-back', () => {
    const preferences = new Map<string, { model?: string }>();
    const startupModel = 'gpt-5.6-luna';
    const key = 'single:user-a';

    setConversationModel(preferences, key, 'gpt-5.6-sol');
    expect(
      weComModelOptions({
        startupModel,
        currentModel: effectiveModel(preferences, key, startupModel),
        configuredModels: ['gpt-5.6-sol'],
      }).map((option) => option.value),
    ).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna']);

    setConversationModel(preferences, key, startupModel);
    expect(effectiveModel(preferences, key, startupModel)).toBe(startupModel);
  });
});
