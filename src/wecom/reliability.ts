export {
  OperationRunner as WeComOperationRunner,
  OperationTimeoutError as WeComOperationTimeoutError,
  CircuitOpenError as WeComCircuitOpenError,
  failureKind,
  type FailureKind as WeComFailureKind,
  type OperationPolicy as WeComOperationPolicy,
} from '../bridge/reliability';
type WeComQueueReason = 'queue-full' | 'queue-timeout' | 'shutting-down';

export function capacityNotice(reason: WeComQueueReason): string {
  if (reason === 'queue-full') return '任务队列已满';
  if (reason === 'queue-timeout') return '排队等待超时';
  return '服务正在停止';
}

export function conversationQueueNotice(reason: WeComQueueReason): string {
  if (reason === 'queue-full') return '当前会话队列已满';
  if (reason === 'queue-timeout') return '等待时间过长，消息已从队列移除，请重新发送';
  return '服务正在停止';
}

export function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function classifyTask(
  text: string,
  options: { hasAttachments: boolean; risk: boolean },
): { kind: 'command' | 'codex' | 'risk' | 'attachment'; label: string } {
  const command = text.trim().toLowerCase();
  if (command.startsWith('/')) {
    return { kind: 'command', label: commandLabel(command) };
  }
  if (options.risk) return { kind: 'risk', label: '风险测算 / 查询' };
  if (options.hasAttachments) return { kind: 'attachment', label: '附件分析' };
  return { kind: 'codex', label: 'Codex 对话' };
}

function commandLabel(command: string): string {
  if (command === '/doctor') return '系统诊断';
  if (command === '/runs') return '最近任务';
  if (command === '/menu') return '打开工作台';
  if (command === '/status') return '查看状态';
  if (command === '/settings') return '查看设置';
  if (command === '/workspace') return '选择工作区';
  if (command === '/model') return '选择模型';
  if (command === '/reasoning') return '选择推理强度';
  if (command === '/resume') return '恢复会话';
  if (command === '/stop') return '停止任务';
  if (command === '/new' || command === '/reset') return '新建会话';
  if (command === '/help') return '查看帮助';
  if (command.startsWith('/测算')) return '风险测算 / 查询';
  return '控制命令';
}
