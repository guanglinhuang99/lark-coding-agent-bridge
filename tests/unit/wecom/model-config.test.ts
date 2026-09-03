import { describe, expect, it } from 'vitest';
import { resolveWeComModelConfig } from '../../../src/wecom/model-config';

describe('WeCom model config', () => {
  it('uses GPT-5.6 Luna at max effort for normal runs and GPT-5.3 Codex Spark for risk intent by default', () => {
    expect(resolveWeComModelConfig({})).toEqual({
      codexModel: 'gpt-5.6-luna',
      codexReasoningEffort: 'max',
      riskIntentModel: 'gpt-5.3-codex-spark',
    });
  });

  it('allows the normal and risk-intent models to be overridden independently', () => {
    expect(
      resolveWeComModelConfig({
        WECOM_CODEX_MODEL: 'custom-main',
        WECOM_CODEX_REASONING_EFFORT: 'xhigh',
        WECOM_RISK_INTENT_MODEL: 'custom-intent',
      }),
    ).toEqual({
      codexModel: 'custom-main',
      codexReasoningEffort: 'xhigh',
      riskIntentModel: 'custom-intent',
    });
  });

  it('falls back when an override is blank', () => {
    expect(
      resolveWeComModelConfig({
        WECOM_CODEX_MODEL: '  ',
        WECOM_CODEX_REASONING_EFFORT: ' ',
        WECOM_RISK_INTENT_MODEL: '',
      }),
    ).toEqual({
      codexModel: 'gpt-5.6-luna',
      codexReasoningEffort: 'max',
      riskIntentModel: 'gpt-5.3-codex-spark',
    });
  });
});
