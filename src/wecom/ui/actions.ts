export const WECOM_CARD_ACTIONS = {
  run: {
    stop: 'stop',
    newSession: 'new',
    status: 'status',
  },
  selection: {
    submit: 'submit',
  },
  ui: {
    home: 'ui.home',
  },
  workspace: {
    select: 'workspace.select',
  },
  model: {
    select: 'model.select',
  },
  reasoning: {
    select: 'reasoning.select',
  },
  session: {
    resume: 'session.resume',
  },
} as const;
