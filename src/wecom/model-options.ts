import type { ModelOption } from '../agent/models';

export interface WeComModelOptionInput {
  startupModel: string;
  currentModel: string;
  configuredModels?: readonly string[];
}

/**
 * Build the WeCom model picker from models that are actually valid for this
 * bridge instance. The startup model is always retained so a conversation can
 * recover after switching away from it.
 *
 * Additional models must be explicitly configured; the generic Codex picker is
 * intentionally not used because its static list can diverge from the locally
 * authenticated subscription/runtime.
 */
export function weComModelOptions(input: WeComModelOptionInput): ModelOption[] {
  const startupModel = input.startupModel.trim();
  const currentModel = input.currentModel.trim();
  const configured = input.configuredModels ?? [];
  const values = dedupe([
    currentModel,
    startupModel,
    ...configured.map((value) => value.trim()),
  ]).filter(Boolean);

  return values.map((value) => ({
    value,
    label:
      value === currentModel
        ? `${value}（当前）`
        : value === startupModel
          ? `${value}（启动默认）`
          : value,
  }));
}

export function readWeComModelAllowlist(value: string | undefined): string[] {
  return dedupe(
    (value ?? '')
      .replaceAll('，', ',')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
