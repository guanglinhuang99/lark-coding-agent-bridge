import type { WeComTaskRecord, WeComTaskStoreSnapshot } from '../task-store';
import type { WeComCardView, WeComTuiStepStatus } from './model';
import { statusColor } from './theme';

export type WeComDependencyStatus = 'ok' | 'warning' | 'error';

export interface WeComDependencyCheck {
  name: string;
  status: WeComDependencyStatus;
  detail: string;
}

export function buildWeComDoctorCardView(options: {
  taskId: string;
  dependencies: readonly WeComDependencyCheck[];
  tasks: WeComTaskStoreSnapshot;
  queueActive: number;
  queueStarting: number;
}): WeComCardView {
  const overall = overallStatus(options.dependencies);
  const recovered = options.tasks.recoveredAtStartup;
  const summary =
    overall === 'error'
      ? '检测到不可用依赖，请先处理红色项目。'
      : overall === 'warning'
        ? '核心服务可用，但有项目需要关注。'
        : '核心依赖均正常。';

  return {
    kind: 'notice',
    taskId: options.taskId,
    source: 'WeCom Reliability',
    sourceColor: statusColor(overall === 'ok' ? 'success' : overall),
    title: '🩺 系统诊断',
    description: summary,
    subtitle: recovered > 0
      ? `本次启动已恢复识别 ${recovered} 个未完成任务；可用 /runs 查看。`
      : '可用 /runs 查看最近任务；失败后直接重新执行 /doctor 即可复检。',
    tui: {
      status: overall === 'ok' ? 'success' : overall,
      eyebrow: 'WECOM · DOCTOR',
      body: `任务：运行 ${options.tasks.running} · 排队 ${options.tasks.queued} · 失败 ${options.tasks.failed} · 中断 ${options.tasks.interrupted} · /runs 查看`,
      steps: options.dependencies.map((item) => ({
        label: `${item.name}: ${item.detail}`,
        status: stepStatus(item.status),
      })),
    },
    facts: [
      ...options.dependencies.map((item) => ({
        label: `${icon(item.status)} ${item.name}`,
        value: clip(item.detail, 34),
      })),
      {
        label: '任务状态',
        value: `run ${options.queueActive} · starting ${options.queueStarting} · stored ${options.tasks.total}`,
      },
    ],
  };
}

export function buildWeComRecentTasksCardView(options: {
  taskId: string;
  tasks: readonly WeComTaskRecord[];
  nowMs?: number;
}): WeComCardView {
  const nowMs = options.nowMs ?? Date.now();
  return {
    kind: 'notice',
    taskId: options.taskId,
    source: 'WeCom Reliability',
    sourceColor: statusColor('idle'),
    title: '🕘 最近任务',
    description: options.tasks.length > 0 ? '最近处理记录（不保存原始消息内容）' : '暂无任务记录',
    subtitle: '任务记录用于去重、异常恢复和状态追踪。',
    tui: {
      status: 'idle',
      eyebrow: 'WECOM · RUNS',
      body: options.tasks.length > 0
        ? options.tasks.map((task) => formatTaskLine(task, nowMs)).join('\n')
        : '尚未记录任务。',
      steps: options.tasks.slice(0, 5).map((task) => ({
        label: `${task.label} · ${statusLabel(task.status)}`,
        status: taskStepStatus(task.status),
      })),
    },
    facts: options.tasks.slice(0, 6).map((task) => ({
      label: `${statusIcon(task.status)} ${clip(task.label, 16)}`,
      value: `${statusLabel(task.status)} · ${relativeTime(Date.parse(task.updatedAt), nowMs)}${task.attempts > 1 ? ` · ${task.attempts}次` : ''}`,
    })),
  };
}

export function recentTaskHint(task: WeComTaskRecord | undefined, nowMs = Date.now()): string | undefined {
  if (!task) return undefined;
  return `${statusIcon(task.status)} ${clip(task.label, 16)} · ${statusLabel(task.status)} · ${relativeTime(Date.parse(task.updatedAt), nowMs)}`;
}

function overallStatus(items: readonly WeComDependencyCheck[]): WeComDependencyStatus {
  if (items.some((item) => item.status === 'error')) return 'error';
  if (items.some((item) => item.status === 'warning')) return 'warning';
  return 'ok';
}

function stepStatus(status: WeComDependencyStatus): WeComTuiStepStatus {
  if (status === 'error') return 'error';
  if (status === 'warning') return 'pending';
  return 'done';
}

function taskStepStatus(status: WeComTaskRecord['status']): WeComTuiStepStatus {
  if (status === 'failed') return 'error';
  if (status === 'queued' || status === 'interrupted') return 'pending';
  if (status === 'running') return 'running';
  return 'done';
}

function statusLabel(status: WeComTaskRecord['status']): string {
  if (status === 'queued') return '排队';
  if (status === 'running') return '运行中';
  if (status === 'done') return '完成';
  if (status === 'failed') return '失败';
  return '已中断';
}

function statusIcon(status: WeComTaskRecord['status']): string {
  if (status === 'done') return '✅';
  if (status === 'failed') return '❌';
  if (status === 'running') return '⚙️';
  if (status === 'queued') return '⏳';
  return '⏹';
}

function icon(status: WeComDependencyStatus): string {
  if (status === 'ok') return '✅';
  if (status === 'warning') return '⚠️';
  return '❌';
}

function formatTaskLine(task: WeComTaskRecord, nowMs: number): string {
  return `${statusIcon(task.status)} ${task.label} · ${statusLabel(task.status)} · ${relativeTime(Date.parse(task.updatedAt), nowMs)}`;
}

function relativeTime(timestamp: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - timestamp);
  if (diff < 60_000) return '刚刚';
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}小时前`;
  return `${Math.floor(diff / (24 * 60 * 60_000))}天前`;
}

function clip(value: string, maxCodePoints: number): string {
  const chars = Array.from(value);
  return chars.length > maxCodePoints
    ? `${chars.slice(0, Math.max(0, maxCodePoints - 1)).join('')}…`
    : value;
}
