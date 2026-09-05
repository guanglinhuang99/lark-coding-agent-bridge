import { readFile, writeFile, rm } from 'node:fs/promises';

const cliPath = 'src/wecom/cli.ts';
const taskStorePath = 'src/wecom/task-store.ts';

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`Patch anchor not found: ${label}`);
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Patch anchor is not unique: ${label}`);
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

let cli = await readFile(cliPath, 'utf8');

cli = replaceOnce(
  cli,
  `} from './risk/intent';\n\ntype TextFrame = WsFrame<TextMessage>;`,
  `} from './risk/intent';\nimport { WeComTaskStore } from './task-store';\nimport {\n  WeComOperationRunner,\n  capacityNotice,\n  classifyTask,\n  conversationQueueNotice,\n  failureKind,\n  readPositiveInt,\n} from './reliability';\nimport {\n  buildWeComDoctorCardView,\n  buildWeComRecentTasksCardView,\n  recentTaskHint,\n} from './ui/doctor';\n\ntype TextFrame = WsFrame<TextMessage>;`,
  'reliability imports',
);

cli = replaceOnce(
  cli,
  `  taskId: string;\n  threadId?: string;\n}`,
  `  taskId: string;\n  threadId?: string;\n  durableTaskId?: string;\n}`,
  'active run durable task',
);

cli = replaceOnce(
  cli,
  `const sessionFile = path.join(stateDir, 'sessions.json');\nconst healthFile = path.join(stateDir, 'health.json');`,
  `const sessionFile = path.join(stateDir, 'sessions.json');\nconst taskFile = path.join(stateDir, 'tasks.json');\nconst healthFile = path.join(stateDir, 'health.json');`,
  'task file path',
);

cli = replaceOnce(
  cli,
  `const sessionMaxEntries = readPositiveInt(process.env.WECOM_SESSION_MAX_ENTRIES, 2_000);\nconst mediaDir = path.join(stateDir, 'media');`,
  `const sessionMaxEntries = readPositiveInt(process.env.WECOM_SESSION_MAX_ENTRIES, 2_000);\nconst taskMaxAgeMs = readPositiveInt(\n  process.env.WECOM_TASK_TTL_MS,\n  7 * 24 * 60 * 60 * 1000,\n);\nconst taskMaxEntries = readPositiveInt(process.env.WECOM_TASK_MAX_ENTRIES, 2_000);\nconst mediaDir = path.join(stateDir, 'media');`,
  'task store config',
);

cli = replaceOnce(
  cli,
  `await sessionStore.load();\nconst activeRuns = new Map<string, ActiveRunRecord>();`,
  `await sessionStore.load();\nconst taskStore = new WeComTaskStore(taskFile, {\n  maxAgeMs: taskMaxAgeMs,\n  maxEntries: taskMaxEntries,\n});\nawait taskStore.load();\nconst operationRunner = new WeComOperationRunner();\nconst activeRuns = new Map<string, ActiveRunRecord>();`,
  'task store initialization',
);

const oldMessageHandler = `function handleMessageEvent<T extends BaseMessage>(frame: WsFrame<T>): void {\n  const messageId = frame.body?.msgid;\n  if (messageId && !messageDeduplicator.claim(messageId)) {\n    log.info('wecom-message', 'duplicate', { messageId });\n    reportMetric('wecom_duplicate_message', 1);\n    return;\n  }\n  void handleMessage(frame).catch(async (err: unknown) => {\n    const message = redactDiagnosticText(err instanceof Error ? err.message : String(err));\n    log.fail('wecom-message', err);\n    reportMetric('wecom_message_failures', 1, { kind: failureKind(err) });\n    console.error(\`Message handling failed: \${message}\`);\n    await replyOnce(frame, '⚠️ 处理失败', [weComUserErrorMarkdown('execution')]).catch(() => {});\n  });\n}\n\nasync function handleMessage<T extends BaseMessage>(frame: WsFrame<T>): Promise<void> {`;
const newMessageHandler = `function handleMessageEvent<T extends BaseMessage>(frame: WsFrame<T>): void {\n  void processMessageEvent(frame).catch(async (err: unknown) => {\n    const message = redactDiagnosticText(err instanceof Error ? err.message : String(err));\n    log.fail('wecom-message', err);\n    reportMetric('wecom_message_failures', 1, { kind: failureKind(err) });\n    console.error(\`Message handling failed: \${message}\`);\n    await replyOnce(frame, '⚠️ 处理失败', [weComUserErrorMarkdown('execution')]).catch(() => {});\n  });\n}\n\nasync function processMessageEvent<T extends BaseMessage>(frame: WsFrame<T>): Promise<void> {\n  const messageId = frame.body?.msgid;\n  if (messageId && !messageDeduplicator.claim(messageId)) {\n    log.info('wecom-message', 'duplicate-memory');\n    reportMetric('wecom_duplicate_message', 1, { layer: 'memory' });\n    return;\n  }\n\n  let durableTaskId: string | undefined;\n  if (messageId && frame.body) {\n    const claim = await taskStore.claimInbound(messageId, conversationKey(frame.body));\n    if (!claim.accepted) {\n      log.info('wecom-message', 'duplicate-durable', { status: claim.task.status });\n      reportMetric('wecom_duplicate_message', 1, { layer: 'durable' });\n      return;\n    }\n    durableTaskId = claim.task.id;\n    if (claim.replayed) {\n      log.info('wecom-task', 'replayed-after-restart', { taskId: durableTaskId });\n      reportMetric('wecom_task_replayed_after_restart', 1);\n    }\n  }\n\n  try {\n    await handleMessage(frame, durableTaskId);\n    if (durableTaskId) await taskStore.markDone(durableTaskId);\n  } catch (err) {\n    if (durableTaskId) await taskStore.markFailed(durableTaskId, failureKind(err)).catch(() => {});\n    throw err;\n  }\n}\n\nasync function handleMessage<T extends BaseMessage>(\n  frame: WsFrame<T>,\n  durableTaskId?: string,\n): Promise<void> {`;
cli = replaceOnce(cli, oldMessageHandler, newMessageHandler, 'durable message handling');

cli = replaceOnce(
  cli,
  `  const key = conversationKey(body);\n  const parsedCommand = parseWeComCommand(text);\n  if (parsedCommand.kind === 'help') {`,
  `  const key = conversationKey(body);\n  const parsedCommand = parseWeComCommand(text);\n  if (durableTaskId) {\n    const task = classifyTask(text, {\n      hasAttachments: mediaInputs.length > 0,\n      risk: parsedCommand.kind === 'risk-measurement',\n    });\n    await taskStore.annotate(durableTaskId, task).catch((err: unknown) => {\n      log.fail('wecom-task', err, { step: 'annotate' });\n    });\n  }\n  if (parsedCommand.kind === 'help') {`,
  'task classification',
);

cli = replaceOnce(
  cli,
  `  if (command === '/menu') {\n    await replyHomeCard(frame, key);\n    return;\n  }\n\n  if (command === '/workspace') {`,
  `  if (command === '/menu') {\n    await replyHomeCard(frame, key);\n    return;\n  }\n\n  if (command === '/doctor') {\n    await replyDoctor(frame, key);\n    return;\n  }\n\n  if (command === '/runs') {\n    await replyRuns(frame, key);\n    return;\n  }\n\n  if (command === '/workspace') {`,
  'doctor and runs commands',
);

cli = replaceOnce(
  cli,
  `  const useRiskFastPath = riskCandidate && !riskAccessDenied;\n  const acknowledgement = text`,
  `  const useRiskFastPath = riskCandidate && !riskAccessDenied;\n  if (durableTaskId && useRiskFastPath) {\n    await taskStore.annotate(durableTaskId, { kind: 'risk', label: '风险测算 / 查询' }).catch(() => {});\n  }\n  const acknowledgement = text`,
  'risk task classification',
);

cli = replaceOnce(
  cli,
  `        controlTaskId,\n        controlCardAttached,\n      );`,
  `        controlTaskId,\n        controlCardAttached,\n        durableTaskId,\n      );`,
  'conversation durable task propagation',
);

cli = replaceOnce(
  cli,
  `  controlTaskId: string,\n  controlCardAttached: boolean,\n): Promise<void> {\n  const submittedAt = Date.now();`,
  `  controlTaskId: string,\n  controlCardAttached: boolean,\n  durableTaskId?: string,\n): Promise<void> {\n  const submittedAt = Date.now();\n  if (durableTaskId) await taskStore.markRunning(durableTaskId);`,
  'execute message durable task',
);

cli = replaceOnce(
  cli,
  `          controlTaskId,\n          controlCardAttached,\n        );`,
  `          controlTaskId,\n          controlCardAttached,\n          durableTaskId,\n        );`,
  'codex durable task propagation',
);

cli = replaceOnce(
  cli,
  `  taskId: string,\n  controlCardAttached: boolean,\n): Promise<void> {`,
  `  taskId: string,\n  controlCardAttached: boolean,\n  durableTaskId?: string,\n): Promise<void> {`,
  'run codex durable task signature',
);

cli = replaceOnce(
  cli,
  `    reportMetric('wecom_run_e2e_ms', Date.now() - requestStartedAt, { terminal: 'failed-start' });\n    console.error(\`Failed to start Codex run: \${redactDiagnosticText(message)}\`);`,
  `    reportMetric('wecom_run_e2e_ms', Date.now() - requestStartedAt, { terminal: 'failed-start' });\n    if (durableTaskId) await taskStore.markFailed(durableTaskId, 'agent-startup').catch(() => {});\n    console.error(\`Failed to start Codex run: \${redactDiagnosticText(message)}\`);`,
  'agent startup task failure',
);

cli = replaceOnce(
  cli,
  `    taskId,\n    threadId,\n  };`,
  `    taskId,\n    threadId,\n    durableTaskId,\n  };`,
  'active durable task id',
);

cli = replaceOnce(
  cli,
  `      state = finalizeIfRunning(state);\n      active.state = state;\n      active.threadId = threadId;\n      await persistThread(key, threadId);`,
  `      state = finalizeIfRunning(state);\n      active.state = state;\n      active.threadId = threadId;\n      if (durableTaskId) {\n        if (state.terminal === 'done') await taskStore.markDone(durableTaskId);\n        else if (state.terminal === 'interrupted') await taskStore.markInterrupted(durableTaskId);\n        else await taskStore.markFailed(durableTaskId, state.terminal);\n      }\n      await persistThread(key, threadId);`,
  'codex terminal task state',
);

cli = replaceOnce(
  cli,
  `      reportMetric('wecom_run_failures', 1, { kind: failureKind(err), step: 'run' });\n      console.error(\`Codex run failed: \${redactDiagnosticText(message)}\`);`,
  `      reportMetric('wecom_run_failures', 1, { kind: failureKind(err), step: 'run' });\n      if (durableTaskId) await taskStore.markFailed(durableTaskId, failureKind(err)).catch(() => {});\n      console.error(\`Codex run failed: \${redactDiagnosticText(message)}\`);`,
  'codex caught task failure',
);

cli = replaceOnce(
  cli,
  `async function replyHomeCard(frame: WsFrame, key: string): Promise<void> {\n  await client.replyTemplateCard(frame, renderWeComCard(buildHomeCardView(homeCardOptions(key))));\n}\n\nasync function replySettingsSummary`,
  `async function replyHomeCard(frame: WsFrame, key: string): Promise<void> {\n  await client.replyTemplateCard(frame, renderWeComCard(buildHomeCardView(homeCardOptions(key))));\n}\n\nasync function replyDoctor(frame: WsFrame, key: string): Promise<void> {\n  const taskSnapshot = taskStore.snapshot();\n  const riskConfigured = Boolean(riskPython || configuredRiskServiceDir);\n  const circuitOpen = ['codex-history', 'media-download'].some(\n    (name) => operationRunner.snapshot(name).state === 'open',\n  );\n  const dependencies = [\n    {\n      name: 'WeCom',\n      status: connected ? 'ok' : 'error',\n      detail: connected ? 'connected' : healthPhase,\n    },\n    { name: 'Codex', status: 'ok', detail: effectiveModel(key) || 'default model' },\n    {\n      name: 'Workspace',\n      status: existsSync(workspace) ? 'ok' : 'error',\n      detail: existsSync(workspace) ? path.basename(workspace) : 'path unavailable',\n    },\n    {\n      name: 'Risk Service',\n      status: riskDirectEnabled ? 'ok' : riskConfigured ? 'error' : 'warning',\n      detail: riskDirectEnabled ? 'ready' : riskConfigured ? 'configuration unavailable' : 'not enabled',\n    },\n    { name: 'Task Store', status: 'ok', detail: \`\${taskSnapshot.total} records\` },\n    {\n      name: 'Retry / Circuit',\n      status: circuitOpen ? 'warning' : 'ok',\n      detail: circuitOpen ? 'downstream circuit open' : 'closed',\n    },\n  ] as const;\n  await client.replyTemplateCard(\n    frame,\n    renderWeComCard(\n      buildWeComDoctorCardView({\n        taskId: createTaskId(),\n        dependencies,\n        tasks: taskSnapshot,\n        queueActive: activeRuns.size,\n        queueStarting: startingRuns.size,\n      }),\n    ),\n  );\n}\n\nasync function replyRuns(frame: WsFrame, key: string): Promise<void> {\n  const recent = taskStore\n    .recent(key, 8)\n    .filter((task) => task.label !== '最近任务')\n    .slice(0, 6);\n  await client.replyTemplateCard(\n    frame,\n    renderWeComCard(buildWeComRecentTasksCardView({ taskId: createTaskId(), tasks: recent })),\n  );\n}\n\nasync function replySettingsSummary`,
  'doctor functions',
);

cli = replaceOnce(
  cli,
  `    reasoning: effectiveReasoningEffort(key),\n    threadId: currentThreadId(key),\n  };`,
  `    reasoning: effectiveReasoningEffort(key),\n    threadId: currentThreadId(key),\n    recentTask: recentTaskHint(\n      taskStore.recent(key, 5).find((task) => task.status !== 'queued' && task.status !== 'running'),\n    ),\n  };`,
  'home recent task',
);

cli = replaceOnce(
  cli,
  `    const history = await listCodexThreadHistory({\n      binary: process.env.CODEX_BINARY?.trim() || 'codex',\n      cwd: workspace,\n      limit: 10,\n      profileStateDir: stateDir,\n      inheritCodexHome: true,\n      timeoutMs: 5_000,\n    });`,
  `    const history = await operationRunner.run(\n      'codex-history',\n      () =>\n        listCodexThreadHistory({\n          binary: process.env.CODEX_BINARY?.trim() || 'codex',\n          cwd: workspace,\n          limit: 10,\n          profileStateDir: stateDir,\n          inheritCodexHome: true,\n          timeoutMs: 5_000,\n        }),\n      { idempotent: true, maxAttempts: 2, timeoutMs: 6_000 },\n    );`,
  'history reliability',
);

cli = replaceOnce(
  cli,
  `    attachments = await mediaStore.resolve(inputs, attachmentOptions);`,
  `    attachments = await operationRunner.run(\n      'media-download',\n      () => mediaStore.resolve(inputs, attachmentOptions),\n      {\n        idempotent: true,\n        maxAttempts: 2,\n        timeoutMs: attachmentOptions.downloadTimeoutMs + 5_000,\n      },\n    );`,
  'media reliability',
);

cli = replaceOnce(
  cli,
  `    const sessionsRemoved = await sessionStore.prune();\n    const cardsRemoved = navigationCards.prune();`,
  `    const sessionsRemoved = await sessionStore.prune();\n    const tasksRemoved = await taskStore.prune();\n    const cardsRemoved = navigationCards.prune();`,
  'task maintenance prune',
);

cli = replaceOnce(
  cli,
  `    reportMetric('wecom_maintenance_removed', sessionsRemoved, { kind: 'sessions' });\n    reportMetric('wecom_maintenance_removed', cardsRemoved, { kind: 'cards' });\n    log.info('wecom-maintenance', 'completed', {\n      logsRemoved,\n      mediaRemoved,\n      sessionsRemoved,\n      cardsRemoved,\n    });`,
  `    reportMetric('wecom_maintenance_removed', sessionsRemoved, { kind: 'sessions' });\n    reportMetric('wecom_maintenance_removed', tasksRemoved, { kind: 'tasks' });\n    reportMetric('wecom_maintenance_removed', cardsRemoved, { kind: 'cards' });\n    log.info('wecom-maintenance', 'completed', {\n      logsRemoved,\n      mediaRemoved,\n      sessionsRemoved,\n      tasksRemoved,\n      cardsRemoved,\n    });`,
  'task maintenance metrics',
);

cli = replaceOnce(
  cli,
  `    await sessionStore.flush().catch((err: unknown) => {\n      console.error(\n        \`Failed to flush WeCom sessions during \${signal}: \${err instanceof Error ? err.message : String(err)}\`,\n      );\n    });\n    await healthStore.flush().catch(() => {});`,
  `    await sessionStore.flush().catch((err: unknown) => {\n      console.error(\n        \`Failed to flush WeCom sessions during \${signal}: \${err instanceof Error ? err.message : String(err)}\`,\n      );\n    });\n    await taskStore.flush().catch((err: unknown) => {\n      console.error(\n        \`Failed to flush WeCom tasks during \${signal}: \${err instanceof Error ? err.message : String(err)}\`,\n      );\n    });\n    await healthStore.flush().catch(() => {});`,
  'task shutdown flush',
);

for (const [label, before] of [
  [
    'local readPositiveInt',
    `function readPositiveInt(value: string | undefined, fallback: number): number {\n  const parsed = value ? Number(value) : fallback;\n  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;\n  return Math.floor(parsed);\n}\n\n`,
  ],
  [
    'local capacityNotice',
    `function capacityNotice(reason: WeComRunCapacityError['reason']): string {\n  if (reason === 'queue-full') return '任务队列已满';\n  if (reason === 'queue-timeout') return '排队等待超时';\n  return '服务正在停止';\n}\n\n`,
  ],
  [
    'local conversationQueueNotice',
    `function conversationQueueNotice(reason: WeComConversationQueueError['reason']): string {\n  if (reason === 'queue-full') return '当前会话队列已满';\n  if (reason === 'queue-timeout') return '等待时间过长，消息已从队列移除，请重新发送';\n  return '服务正在停止';\n}\n\n`,
  ],
  [
    'local failureKind',
    `function failureKind(err: unknown): string {\n  const item =\n    err && typeof err === 'object'\n      ? (err as { name?: unknown; code?: unknown; response?: { status?: unknown } })\n      : {};\n  if (item.name === 'WeComMediaTimeoutError') return 'timeout';\n  const status = item.response?.status;\n  if (typeof status === 'number') {\n    if (status === 429) return 'rate-limit';\n    if (status >= 500) return 'http-5xx';\n    if (status >= 400) return 'http-4xx';\n  }\n  const code = typeof item.code === 'string' ? item.code.toUpperCase() : '';\n  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') return 'timeout';\n  if (code.startsWith('ECONN') || code.startsWith('ENET') || code === 'EHOSTUNREACH') {\n    return 'network';\n  }\n  return 'other';\n}\n\n`,
  ],
]) {
  cli = replaceOnce(cli, before, '', label);
}

await writeFile(cliPath, cli);

let taskStore = await readFile(taskStorePath, 'utf8');
taskStore = replaceOnce(
  taskStore,
  `  recent(conversationKey?: string, limit = 5): WeComTaskRecord[] {\n    return Object.values(this.tasks)\n      .filter((task) => !conversationKey || task.conversationKey === conversationKey)\n      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))\n      .slice(0, Math.max(0, limit))\n      .map(cloneTask);\n  }\n\n  snapshot(): WeComTaskStoreSnapshot {`,
  `  recent(conversationKey?: string, limit = 5): WeComTaskRecord[] {\n    return Object.values(this.tasks)\n      .filter((task) => !conversationKey || task.conversationKey === conversationKey)\n      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))\n      .slice(0, Math.max(0, limit))\n      .map(cloneTask);\n  }\n\n  active(conversationKey: string): WeComTaskRecord | undefined {\n    return this.recent(conversationKey, this.maxEntries).find(\n      (task) => task.status === 'running' || task.status === 'queued',\n    );\n  }\n\n  snapshot(): WeComTaskStoreSnapshot {`,
  'task active lookup',
);

taskStore = replaceOnce(
  taskStore,
  `    const task = this.tasks[taskId];\n    if (!task) return;\n    task.status = status;`,
  `    const task = this.tasks[taskId];\n    if (!task) return;\n    if (status === 'done' && (task.status === 'failed' || task.status === 'interrupted')) return;\n    task.status = status;`,
  'preserve terminal task failure',
);
await writeFile(taskStorePath, taskStore);

await rm('scripts/apply-wecom-reliability-patch.mjs', { force: true });
await rm('.github/workflows/wecom-reliability-patch.yml', { force: true });
