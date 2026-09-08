import type { SandboxMode } from '../../config/profile-schema';

export interface BuildCodexArgsInput {
  cwd: string;
  /** Minimal, non-agentic transaction extraction. */
  purpose?: 'risk-intent';
  instructionsFile?: string;
  sandbox: SandboxMode;
  threadId?: string;
  images?: readonly string[];
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  /** Forwarded to `codex exec --model`. Omitted uses the Codex default. */
  model?: string;
  /** Forwarded to Codex config as `model_reasoning_effort`. */
  reasoningEffort?: string;
}

export function buildCodexArgs(input: BuildCodexArgsInput): string[] {
  if (
    input.sandbox !== 'read-only' &&
    input.sandbox !== 'workspace-write' &&
    input.sandbox !== 'danger-full-access'
  ) {
    throw new Error(`unsafe sandbox mode: ${input.sandbox}`);
  }

  const extractionFlags = input.purpose === 'risk-intent'
    ? [
        'project_doc_max_bytes=0',
        'skills.include_instructions=false',
        'features.skill_search=false',
        'orchestrator.skills.enabled=false',
        'orchestrator.mcp.enabled=false',
        'features.apps=false',
        'features.remote_plugin=false',
        'features.shell_tool=false',
        'features.shell_snapshot=false',
        'features.browser_use=false',
        'features.computer_use=false',
        'features.image_generation=false',
        'agents.enabled=false',
        'web_search="disabled"',
      ].flatMap(value => ['-c', value])
    : [];
  const globalFlags = [
    ...extractionFlags,
    ...(input.purpose === 'risk-intent' && input.instructionsFile
      ? ['-c', `model_instructions_file=${JSON.stringify(input.instructionsFile)}`]
      : []),
    '--sandbox',
    input.sandbox,
    ...(input.model ? ['--model', input.model] : []),
    ...(input.reasoningEffort
      ? ['-c', `model_reasoning_effort="${input.reasoningEffort}"`]
      : []),
    '-c',
    'approval_policy="never"',
    '-c',
    'shell_environment_policy.inherit="all"',
    ...(input.ignoreUserConfig === true ? ['--ignore-user-config'] : []),
    ...(input.ignoreRules === false ? [] : ['--ignore-rules']),
    '--skip-git-repo-check',
    '-C',
    input.cwd,
  ];

  const imageFlags = (input.images ?? []).flatMap((path) => ['--image', path]);

  if (input.threadId) {
    return [
      'exec',
      ...globalFlags,
      'resume',
      '--json',
      ...imageFlags,
      input.threadId,
      '-',
    ];
  }

  return [
    'exec',
    '--json',
    ...globalFlags,
    ...imageFlags,
    ...(imageFlags.length > 0 ? ['--'] : []),
    '-',
  ];
}
