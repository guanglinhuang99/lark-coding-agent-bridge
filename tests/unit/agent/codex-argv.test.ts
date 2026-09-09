import { describe, expect, it } from 'vitest';
import { buildCodexArgs } from '../../../src/agent/codex/argv.js';

describe('Codex argv contract', () => {
  it('builds the fresh exec argv without putting the prompt in argv', () => {
    expect(buildCodexArgs({ cwd: '/repo', sandbox: 'read-only' })).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      '-',
    ]);
  });

  it('puts global flags before resume and resume-local flags after resume', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'workspace-write',
        threadId: 'thread-123',
      }),
    ).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      'resume',
      '--json',
      'thread-123',
      '-',
    ]);
  });

  it('allows danger-full-access for Claude bridge parity', () => {
    expect(buildCodexArgs({ cwd: '/repo', sandbox: 'danger-full-access' })).toContain(
      'danger-full-access',
    );
  });

  it('separates image flags from stdin prompt for fresh exec', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'workspace-write',
        images: ['/tmp/image.png'],
      }),
    ).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      '--image',
      '/tmp/image.png',
      '--',
      '-',
    ]);
  });

  it('passes resume image flags after the resume subcommand', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'workspace-write',
        threadId: 'thread-123',
        images: ['/tmp/image.png'],
      }),
    ).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      'resume',
      '--json',
      '--image',
      '/tmp/image.png',
      'thread-123',
      '-',
    ]);
  });

  it('forwards the selected model as a global --model flag before resume', () => {
    const args = buildCodexArgs({
      cwd: '/repo',
      sandbox: 'workspace-write',
      threadId: 'thread-123',
      model: 'gpt-5-codex',
    });
    expect(args).toContain('--model');
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('gpt-5-codex');
    // Global flag: must come before the `resume` subcommand.
    expect(modelIdx).toBeLessThan(args.indexOf('resume'));
  });

  it('omits --model when no model is selected', () => {
    expect(buildCodexArgs({ cwd: '/repo', sandbox: 'read-only' })).not.toContain('--model');
  });

  it('forwards reasoning effort through Codex config', () => {
    const args = buildCodexArgs({
      cwd: '/repo',
      sandbox: 'read-only',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'max',
    });
    expect(args).toContain('model_reasoning_effort="max"');
  });

  it('can explicitly ignore the user config when profile isolation asks for it', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'read-only',
        ignoreUserConfig: true,
      }),
    ).toContain('--ignore-user-config');
  });

  it('builds a compact isolated argv for risk-intent extraction', () => {
    expect(
      buildCodexArgs({
        cwd: '/risk-workspace',
        purpose: 'risk-intent',
        sandbox: 'read-only',
        model: 'gpt-5.5',
        reasoningEffort: 'low',
        ignoreUserConfig: true,
        ignoreRules: true,
      }),
    ).toEqual([
      'exec',
      '--json',
      '-c',
      'project_doc_max_bytes=0',
      '-c',
      'skills.include_instructions=false',
      '-c',
      'features.skill_search=false',
      '-c',
      'orchestrator.skills.enabled=false',
      '-c',
      'orchestrator.mcp.enabled=false',
      '-c',
      'features.apps=false',
      '-c',
      'features.remote_plugin=false',
      '-c',
      'features.shell_tool=false',
      '-c',
      'features.shell_snapshot=false',
      '-c',
      'features.browser_use=false',
      '-c',
      'features.computer_use=false',
      '-c',
      'features.image_generation=false',
      '-c',
      'agents.enabled=false',
      '-c',
      'web_search="disabled"',
      '--sandbox',
      'read-only',
      '--model',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort="low"',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/risk-workspace',
      '-',
    ]);
  });

  it('passes model instructions only for risk-intent purpose', () => {
    const instructionsFile = '/risk workspace/risk-intent/instructions-fixed.txt';
    const riskArgs = buildCodexArgs({
      cwd: '/risk-workspace',
      purpose: 'risk-intent',
      instructionsFile,
      sandbox: 'read-only',
    });
    expect(riskArgs).toContain(`model_instructions_file=${JSON.stringify(instructionsFile)}`);

    const ordinaryArgs = buildCodexArgs({
      cwd: '/workspace',
      instructionsFile,
      sandbox: 'read-only',
    });
    expect(ordinaryArgs.some((arg) => arg.startsWith('model_instructions_file='))).toBe(false);
  });

});
