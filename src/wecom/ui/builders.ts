import { basename } from 'node:path';
import { homedir } from 'node:os';
import type { RunState } from '../../card/run-state';
import type { CodexSandboxMode } from '../../config/permissions';
import { WECOM_CARD_ACTIONS } from './actions';
import type {
  WeComCardButton,
  WeComCardFact,
  WeComCardSelectionOption,
  WeComCardView,
  WeComTuiPanel,
} from './model';
import { statusColor, type WeComUiStatus } from './theme';

export type WeComRunCardStatus = 'running' | 'idle' | 'stopping' | 'reset' | 'error';
export type WeComQueueCardStatus = 'queued' | 'running' | 'queue-full' | 'queue-timeout';
export type WeComErrorKind =
  | 'agent-startup'
  | 'queue-full'
  | 'queue-timeout'
  | 'callback-expired'
  | 'callback-invalid'
  | 'execution';

export interface WeComRunCardOptions {
  taskId: string;
  status: WeComRunCardStatus;
  workspace: string;
  sandbox: CodexSandboxMode;
  threadId?: string;
  prompt?: string;
  notice?: string;
  runState?: RunState;
}

export interface WeComQueueCardOptions {
  taskId: string;
  status: WeComQueueCardStatus;
  workspace?: string;
  ahead?: number;
  position?: number;
}

export interface WeComSelectionCardOptions {
  taskId: string;
  source: string;
  title: string;
  questionKey: string;
  options: WeComCardSelectionOption[];
  description?: string;
  subtitle?: string;
  submitText?: string;
  submitKey?: string;
}

export interface WeComConfirmationCardOptions {
  taskId: string;
  source: string;
  title: string;
  description?: string;
  facts?: WeComCardFact[];
  confirmText?: string;
  confirmKey?: string;
}

export interface WeComNoticeCardOptions {
  taskId: string;
  source: string;
  title: string;
  description?: string;
  subtitle?: string;
  facts?: WeComCardFact[];
  status?: WeComUiStatus;
}

export function buildRunCardView(options: WeComRunCardOptions): WeComCardView {
  const lifecycle = options.runState ? runLifecycle(options.runState) : undefined;
  const running = options.runState
    ? options.runState.terminal === 'running'
    : options.status === 'running' || options.status === 'stopping';
  const status = lifecycle ?? runStatus(options.status);
  const prompt = sanitizeSensitiveText(
    options.prompt?.trim() || '发送消息开始任务；运行状态会持续更新。',
  );

  return {
    kind: 'interactive',
    taskId: options.taskId,
    source: 'CODEX · WECOM',
    sourceColor: status.color,
    title: lifecycle?.title ?? (running ? '正在处理' : '会话控制'),
    description: clip(
      sanitizeSensitiveText(options.notice ?? status.label),
      30,
    ),
    tui: {
      status: status.tuiStatus,
      eyebrow: 'CODEX · WECOM',
      body: prompt,
      steps: lifecycle?.steps ?? controlSteps(options.status),
    },
    buttons: [
      ...(running
        ? [{ text: '停止', key: WECOM_CARD_ACTIONS.run.stop, variant: 'danger' as const }]
        : []),
      { text: '新会话', key: WECOM_CARD_ACTIONS.run.newSession, variant: 'secondary' },
      { text: '查看状态', key: WECOM_CARD_ACTIONS.run.status, variant: 'primary' },
    ],
  };
}

export function buildErrorCardView(options: {
  taskId: string;
  kind: WeComErrorKind;
}): WeComCardView {
  const copy: Record<WeComErrorKind, { title: string; description: string; subtitle: string }> = {
    'agent-startup': {
      title: 'Codex 启动失败',
      description: '暂时无法启动 Codex 任务。',
      subtitle: '请稍后重试；技术细节已记录到 bridge 日志。',
    },
    'queue-full': {
      title: '任务队列已满',
      description: '当前任务较多，本条消息没有入队。',
      subtitle: '请稍后重新发送。',
    },
    'queue-timeout': {
      title: '排队等待超时',
      description: '任务等待时间过长，已从队列移除。',
      subtitle: '请重新发送消息。',
    },
    'callback-expired': {
      title: '卡片已失效',
      description: '该卡片操作已过期或已经处理。',
      subtitle: '请重新打开最新卡片。',
    },
    'callback-invalid': {
      title: '卡片操作无效',
      description: '无法识别这次卡片操作。',
      subtitle: '请使用最新卡片上的按钮。',
    },
    execution: {
      title: '任务执行失败',
      description: 'Codex 任务未能完成。',
      subtitle: '请稍后重试；技术细节已记录到 bridge 日志。',
    },
  };
  const message = copy[options.kind];
  return {
    kind: 'notice',
    taskId: options.taskId,
    source: 'Codex Bridge',
    sourceColor: statusColor('error'),
    title: message.title,
    description: message.description,
    subtitle: message.subtitle,
    tui: {
      status: 'error',
      eyebrow: 'CODEX ERROR',
      body: message.subtitle,
    },
  };
}

export function buildQueueCardView(options: WeComQueueCardOptions): WeComCardView {
  if (options.status === 'queue-full') {
    return buildErrorCardView({ taskId: options.taskId, kind: 'queue-full' });
  }
  if (options.status === 'queue-timeout') {
    return buildErrorCardView({ taskId: options.taskId, kind: 'queue-timeout' });
  }

  const ahead = Math.max(0, options.ahead ?? (options.position ? options.position - 1 : 0));
  return {
    kind: 'notice',
    taskId: options.taskId,
    source: 'Codex Bridge',
    sourceColor: statusColor(options.status === 'queued' ? 'queued' : 'running'),
    title: options.status === 'queued' ? '已加入队列' : '正在处理',
    description:
      options.status === 'queued'
        ? `前面还有 ${ahead} 个任务`
        : '任务已开始处理。',
    facts: [
      ...(options.workspace ? [{ label: '工作区', value: compactWorkspace(options.workspace) }] : []),
      ...(options.status === 'queued' ? [{ label: '排队位置', value: String(ahead + 1) }] : []),
    ],
    subtitle: '前一项完成后会自动开始，无需重新发送。',
    tui: {
      status: options.status === 'queued' ? 'queued' : 'running',
      eyebrow: 'CODEX QUEUE',
      body: options.status === 'queued' ? `前面还有 ${ahead} 个任务` : '任务已开始处理。',
      steps: [
        { label: '消息已接收', status: 'done' },
        { label: options.status === 'queued' ? '等待执行' : '开始执行', status: 'running' },
      ],
    },
  };
}

export function buildSelectionCardView(options: WeComSelectionCardOptions): WeComCardView {
  if (options.options.length === 0 || options.options.length > 10) {
    throw new Error(`Selection card requires 1-10 options; received ${options.options.length}`);
  }
  return {
    kind: 'interactive',
    taskId: options.taskId,
    source: options.source,
    sourceColor: statusColor('warning'),
    title: options.title,
    ...(options.description ? { description: options.description } : {}),
    ...(options.subtitle ? { subtitle: options.subtitle } : {}),
    tui: {
      status: 'warning',
      eyebrow: 'ACTION REQUIRED',
      body: options.subtitle ?? options.description ?? '请选择一项后确认。',
    },
    selection: {
      questionKey: options.questionKey,
      title: options.title,
      options: options.options,
    },
    buttons: [
      {
        text: options.submitText ?? '确认选择',
        key: options.submitKey ?? WECOM_CARD_ACTIONS.selection.submit,
        variant: 'primary',
      },
    ],
  };
}

export function buildConfirmationCardView(
  options: WeComConfirmationCardOptions,
): WeComCardView {
  return {
    kind: 'interactive',
    taskId: options.taskId,
    source: options.source,
    sourceColor: statusColor('warning'),
    title: options.title,
    ...(options.description ? { description: options.description } : {}),
    ...(options.facts?.length ? { facts: options.facts } : {}),
    tui: {
      status: 'warning',
      eyebrow: 'ACTION REQUIRED',
      body: options.description ?? '请确认后继续。',
    },
    buttons: [
      {
        text: options.confirmText ?? '确认',
        key: options.confirmKey ?? WECOM_CARD_ACTIONS.selection.submit,
        variant: 'primary',
      },
    ],
  };
}

export function buildNoticeCardView(options: WeComNoticeCardOptions): WeComCardView {
  return {
    kind: 'notice',
    taskId: options.taskId,
    source: options.source,
    ...(options.status ? { sourceColor: statusColor(options.status) } : {}),
    title: options.title,
    ...(options.description ? { description: options.description } : {}),
    ...(options.subtitle ? { subtitle: options.subtitle } : {}),
    ...(options.facts?.length ? { facts: options.facts } : {}),
    tui: {
      status: options.status ?? 'idle',
      eyebrow: options.source,
      body: options.subtitle ?? options.description,
    },
  };
}

function runStatus(status: WeComRunCardStatus): {
  label: string;
  color: 0 | 1 | 2 | 3;
  tuiStatus: WeComTuiPanel['status'];
} {
  switch (status) {
    case 'running':
      return { label: 'RUNNING · 运行中', color: statusColor('running'), tuiStatus: 'running' };
    case 'stopping':
      return { label: 'STOPPING · 正在停止', color: statusColor('warning'), tuiStatus: 'stopping' };
    case 'reset':
      return { label: 'READY · 新会话', color: statusColor('idle'), tuiStatus: 'idle' };
    case 'error':
      return { label: 'FAILED · 操作失败', color: statusColor('error'), tuiStatus: 'error' };
    case 'idle':
      return { label: 'READY · 空闲', color: statusColor('idle'), tuiStatus: 'idle' };
  }
}

function runLifecycle(state: RunState): ReturnType<typeof runStatus> & {
  title: string;
  steps: NonNullable<WeComTuiPanel['steps']>;
} {
  const steps: NonNullable<WeComTuiPanel['steps']> = [
    { label: '请求已接收', status: 'done' },
  ];

  let status: ReturnType<typeof runStatus>;
  let title: string;
  if (state.terminal === 'done') {
    status = { label: 'DONE · 已完成', color: statusColor('success'), tuiStatus: 'success' };
    title = '处理完成';
    steps.push({ label: '回答已发送', status: 'done' });
  } else if (state.terminal === 'interrupted') {
    status = { label: 'STOPPED · 已中断', color: statusColor('stopped'), tuiStatus: 'stopped' };
    title = '已停止';
    steps.push({ label: '处理已停止', status: 'error' });
  } else if (state.terminal === 'idle_timeout') {
    status = { label: 'TIMEOUT · 已超时', color: statusColor('warning'), tuiStatus: 'warning' };
    title = '处理超时';
    steps.push({ label: '请稍后重试', status: 'error' });
  } else if (state.terminal === 'error') {
    status = { label: 'FAILED · 执行失败', color: statusColor('error'), tuiStatus: 'error' };
    title = '处理失败';
    steps.push({ label: '请稍后重试', status: 'error' });
  } else {
    const streaming = state.footer === 'streaming';
    status = streaming
      ? { label: 'STREAM · 生成回答', color: statusColor('streaming'), tuiStatus: 'streaming' }
      : { label: 'RUNNING · 处理中', color: statusColor('running'), tuiStatus: 'running' };
    title = streaming ? '正在整理回答' : '正在处理';
    steps.push({ label: streaming ? '正在整理回答' : '正在处理请求', status: 'running' });
  }
  return { ...status, title, steps: steps.slice(-4) };
}

function controlSteps(status: WeComRunCardStatus): NonNullable<WeComTuiPanel['steps']> {
  if (status === 'running') {
    return [
      { label: '请求已接收', status: 'done' },
      { label: '正在处理请求', status: 'running' },
    ];
  }
  if (status === 'stopping') {
    return [
      { label: '停止请求已发送', status: 'done' },
      { label: '正在停止', status: 'running' },
    ];
  }
  if (status === 'error') return [{ label: '操作失败', status: 'error' }];
  if (status === 'reset') return [{ label: '新会话已就绪', status: 'done' }];
  return [{ label: '可以发送新消息', status: 'pending' }];
}

function compactWorkspace(workspace: string): string {
  return clip(basename(workspace) || workspace, 40);
}

function clip(value: string, maxCodePoints: number): string {
  const characters = Array.from(value);
  return characters.length > maxCodePoints
    ? `${characters.slice(0, Math.max(0, maxCodePoints - 1)).join('')}…`
    : value;
}

function sanitizeSensitiveText(value: string): string {
  const home = homedir();
  let output = home && home !== '/' ? value.split(home).join('~') : value;
  output = output.replace(
    /\b((?:WECOM_SECRET|OPENAI_API_KEY|[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s`]+)/gi,
    '$1=[REDACTED]',
  );
  output = output.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, '$1[REDACTED]');
  return output.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}
