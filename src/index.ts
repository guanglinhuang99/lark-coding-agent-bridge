// Public exports for consumers that need the same rendering logic the bot uses.
export { renderCard } from './card/run-renderer';
export { renderText } from './card/text-renderer';
export {
  initialState,
  reduce,
  finalizeIfRunning,
  markInterrupted,
} from './card/run-state';
export type { RunState, ToolEntry, Block, ToolStatus, Terminal, FooterStatus } from './card/run-state';

// Platform-neutral Agent UI model plus the native WeCom renderer.
export {
  taskCard,
  resultCard,
  confirmCard,
  errorCard,
  selectionCard,
  statusCard,
  renderWeComAgentCard,
  renderTuiBody,
} from './card-ui/index';
export type {
  AgentCard,
  CardAction,
  CardField,
  CardStatus,
  CardStep,
  CardStepStatus,
  CardTone,
  TaskCardInput,
  ResultCardInput,
  ConfirmCardInput,
  ErrorCardInput,
  SelectionCardInput,
} from './card-ui/index';

// Optional telemetry hook (see README "Optional telemetry"). Types let an
// external adapter package implement the interface via `import type`; the
// runtime helpers are noop unless LARK_CHANNEL_TELEMETRY_MODULE is set.
export type {
  TelemetryAdapter,
  AdapterFactory,
  AdapterMeta,
  TelemetryEvent,
} from './core/telemetry';
export { reportMetric, reportError } from './core/logger';
