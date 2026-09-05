import { describe, expect, it } from 'vitest';
import {
  buildWeComDoctorCardView,
  buildWeComRecentTasksCardView,
  recentTaskHint,
} from '../../../src/wecom/ui/doctor';
import { renderWeComCard } from '../../../src/wecom/ui/renderer';
import type { WeComTaskRecord } from '../../../src/wecom/task-store';

const task: WeComTaskRecord = {
  id: 'task_1',
  operationKey: 'hash',
  conversationKey: 'single:u1',
  kind: 'codex',
  status: 'done',
  label: 'Codex 对话',
  attempts: 1,
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:01:00.000Z',
};

describe('WeCom reliability cards', () => {
  it('renders dependency state and recovered task counts', () => {
    const card = renderWeComCard(
      buildWeComDoctorCardView({
        taskId: 'doctor_1',
        dependencies: [
          { name: 'WeCom', status: 'ok', detail: 'connected' },
          { name: 'Risk Service', status: 'warning', detail: 'disabled' },
        ],
        tasks: {
          total: 3,
          queued: 0,
          running: 0,
          done: 2,
          failed: 0,
          interrupted: 1,
          recoveredAtStartup: 1,
        },
        queueActive: 0,
        queueStarting: 0,
      }),
    );

    expect(card.main_title?.title).toContain('系统诊断');
    expect(card.horizontal_content_list?.some((item) => item.keyname?.includes('WeCom'))).toBe(true);
    expect(card.sub_title_text).toContain('/runs');
  });

  it('renders recent task status without raw prompts', () => {
    const card = renderWeComCard(
      buildWeComRecentTasksCardView({
        taskId: 'runs_1',
        tasks: [task],
        nowMs: Date.parse('2026-09-05T00:02:00.000Z'),
      }),
    );
    expect(card.horizontal_content_list?.[0]?.value).toContain('完成');
    expect(recentTaskHint(task, Date.parse('2026-09-05T00:02:00.000Z'))).toContain('Codex 对话');
  });
});
