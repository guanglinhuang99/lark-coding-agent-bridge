import { describe, expect, it, vi } from 'vitest';
import { inspectLaunchdStatus, parseLaunchdStatus, processIsAlive } from '../../../src/daemon/launchd-status';

const job = (body: string) => `gui/501/example = {\n${body}\n}`;

describe('launchd process status', () => {
  it('does not mistake a loaded crash-backoff job or nested state for running', () => {
    const alive = vi.fn(() => true);
    const text = job('state = spawn scheduled\nruns = 357\nlast exit code = 1\ncoalition = {\nstate = running\npid = 999\n}');
    expect(inspectLaunchdStatus(true, text, alive)).toEqual({
      loaded: true, running: false, state: 'spawn scheduled', pid: undefined, runs: 357, lastExit: '1',
    });
    expect(alive).not.toHaveBeenCalled();
  });
  it('requires both running state and a live positive PID', () => {
    const text = job('state = running\npid = 123\nruns = 1\nlast exit code = (never exited)');
    expect(inspectLaunchdStatus(true, text, () => true)).toMatchObject({ running: true, pid: '123', runs: 1 });
    expect(inspectLaunchdStatus(true, text, () => false).running).toBe(false);
    expect(inspectLaunchdStatus(true, job('state = running'), () => true).running).toBe(false);
    expect(inspectLaunchdStatus(true, job('state = running\npid = 0'), () => true).running).toBe(false);
  });
  it('does not treat missing jobs, malformed output, or raw env fields as healthy', () => {
    expect(inspectLaunchdStatus(false, 'state = running\npid = 1', () => true)).toEqual({ loaded: false, running: false });
    expect(inspectLaunchdStatus(true, '', () => true).running).toBe(false);
    expect(parseLaunchdStatus(job('state = running\npid = 123\nenvironment = {\nstate = error\npid = 456\n}')))
      .toMatchObject({ state: 'running', pid: '123' });
  });
  it('uses signal zero and refuses process-group PIDs', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(processIsAlive(0)).toBe(false);
    expect(processIsAlive(-1)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(processIsAlive(123)).toBe(true);
    expect(kill).toHaveBeenCalledWith(123, 0);
    kill.mockImplementation(() => { throw Object.assign(new Error(), { code: 'EPERM' }); });
    expect(processIsAlive(123)).toBe(true);
    kill.mockImplementation(() => { throw Object.assign(new Error(), { code: 'ESRCH' }); });
    expect(processIsAlive(123)).toBe(false);
    kill.mockRestore();
  });
});
