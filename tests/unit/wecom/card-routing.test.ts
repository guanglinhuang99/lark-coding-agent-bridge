import { describe, expect, it } from 'vitest';
import {
  cardPurposeFromTaskId,
  isHomeAction,
  navigationActionForPurpose,
} from '../../../src/wecom/card-routing';

describe('WeCom card callback namespaces', () => {
  it('isolates current and legacy card task namespaces', () => {
    expect(cardPurposeFromTaskId('menu_1')).toBe('menu');
    expect(cardPurposeFromTaskId('workspace_1')).toBe('workspace');
    expect(cardPurposeFromTaskId('model_1')).toBe('model');
    expect(cardPurposeFromTaskId('reasoning_1')).toBe('reasoning');
    expect(cardPurposeFromTaskId('session_1')).toBe('session');
    expect(cardPurposeFromTaskId('codex_1')).toBe('codex');
    expect(cardPurposeFromTaskId('queue_1')).toBe('queue');
    expect(cardPurposeFromTaskId('risk_1')).toBe('risk');
    expect(cardPurposeFromTaskId('task_1')).toBe('unknown');
  });

  it('maps selectors to explicit namespaced actions', () => {
    expect(navigationActionForPurpose('workspace')).toBe('workspace.select');
    expect(navigationActionForPurpose('model')).toBe('model.select');
    expect(navigationActionForPurpose('reasoning')).toBe('reasoning.select');
    expect(navigationActionForPurpose('session')).toBe('session.resume');
    expect(navigationActionForPurpose('menu')).toBeUndefined();
  });

  it('keeps home actions separate from selector callbacks', () => {
    expect(isHomeAction('stop')).toBe(true);
    expect(isHomeAction('new')).toBe(true);
    expect(isHomeAction('status')).toBe(true);
    expect(isHomeAction('ui.home')).toBe(true);
    expect(isHomeAction('workspace.select')).toBe(false);
    expect(isHomeAction(undefined)).toBe(false);
  });
});
