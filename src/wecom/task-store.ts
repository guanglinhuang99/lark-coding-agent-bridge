import { TaskLedger, type TaskLedgerOptions } from '../bridge/task-ledger';
export {
  hashOperationKey,
  type TaskStatus as WeComTaskStatus,
  type TaskKind as WeComTaskKind,
  type TaskRecord as WeComTaskRecord,
  type TaskClaim as WeComTaskClaim,
  type TaskLedgerSnapshot as WeComTaskStoreSnapshot,
  type TaskLedgerOptions as WeComTaskStoreOptions,
} from '../bridge/task-ledger';
/** Keep v0.8 operation hashes and the explicit deterministic-risk replay policy. */
export class WeComTaskStore extends TaskLedger {
  constructor(file: string, options: TaskLedgerOptions = {}) {
    super(file, { ...options, canReplayRunning: options.canReplayRunning ?? ((task) => task.kind === 'risk') });
  }
}
