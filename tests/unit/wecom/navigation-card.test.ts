import { describe, expect, it } from 'vitest';
import {
  buildHomeCardView,
  buildModelSelectionCardView,
  buildReasoningSelectionCardView,
  buildSessionSelectionCardView,
  buildWorkspaceSelectionCardView,
} from '../../../src/wecom/ui/navigation';
import { renderWeComCard } from '../../../src/wecom/ui/renderer';

describe('WeCom navigation cards', () => {
  it('renders a compact home card with only supported runtime actions', () => {
    const idle = renderWeComCard(
      buildHomeCardView({
        taskId: 'menu_1',
        busy: false,
        workspace: 'wecom-bot',
        model: 'gpt-5.6',
        reasoning: 'high',
      }),
    );
    expect(idle.button_list?.map((button) => button.key)).toEqual(['new', 'status']);

    const busy = renderWeComCard(
      buildHomeCardView({
        taskId: 'menu_2',
        busy: true,
        workspace: 'wecom-bot',
      }),
    );
    expect(busy.button_list?.map((button) => button.key)).toEqual(['stop', 'new', 'status']);
  });

  it('builds workspace selection with the namespaced action key', () => {
    const card = renderWeComCard(
      buildWorkspaceSelectionCardView({
        taskId: 'workspace_1',
        workspaces: [
          { id: 'web-cli', label: 'web-cli' },
          { id: 'wecom-bot', label: 'wecom-bot' },
        ],
      }),
    );

    expect(card.button_selection?.question_key).toBe('workspace');
    expect(card.button_list?.[0]?.key).toBe('workspace.select');
  });

  it('builds model and reasoning selectors with namespaced actions', () => {
    const model = renderWeComCard(
      buildModelSelectionCardView({
        taskId: 'model_1',
        models: [
          { id: 'gpt-5.6', text: 'GPT-5.6' },
          { id: 'gpt-5.4', text: 'GPT-5.4' },
        ],
      }),
    );
    const reasoning = renderWeComCard(
      buildReasoningSelectionCardView({
        taskId: 'reasoning_1',
        levels: [
          { id: 'medium', text: 'Medium' },
          { id: 'high', text: 'High' },
        ],
      }),
    );

    expect(model.button_list?.[0]?.key).toBe('model.select');
    expect(reasoning.button_list?.[0]?.key).toBe('reasoning.select');
  });

  it('builds a recent-session selector and keeps workspace context visible', () => {
    const card = renderWeComCard(
      buildSessionSelectionCardView({
        taskId: 'session_1',
        sessions: [
          { id: 'thread-1', label: 'Fix Outlook extension', workspace: 'web-cli' },
          { id: 'thread-2', label: 'WeCom Card UI', workspace: 'wecom-bot' },
        ],
      }),
    );

    expect(card.button_selection?.question_key).toBe('session');
    expect(card.button_selection?.option_list[0]?.text).toContain('web-cli');
    expect(card.button_list?.[0]?.key).toBe('session.resume');
  });
});
