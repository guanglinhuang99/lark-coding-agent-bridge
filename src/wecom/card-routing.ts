export type WeComCardPurpose =
  | 'menu'
  | 'workspace'
  | 'model'
  | 'reasoning'
  | 'session'
  | 'codex'
  | 'queue'
  | 'risk'
  | 'unknown';

export function cardPurposeFromTaskId(taskId: string): WeComCardPurpose {
  for (const purpose of [
    'menu',
    'workspace',
    'model',
    'reasoning',
    'session',
    'codex',
    'queue',
    'risk',
  ] as const) {
    if (taskId.startsWith(`${purpose}_`)) return purpose;
  }
  return 'unknown';
}

export function navigationActionForPurpose(purpose: WeComCardPurpose): string | undefined {
  switch (purpose) {
    case 'workspace':
      return 'workspace.select';
    case 'model':
      return 'model.select';
    case 'reasoning':
      return 'reasoning.select';
    case 'session':
      return 'session.resume';
    default:
      return undefined;
  }
}

export function isHomeAction(value: string | undefined): boolean {
  return value === 'stop' || value === 'new' || value === 'status' || value === 'ui.home';
}
