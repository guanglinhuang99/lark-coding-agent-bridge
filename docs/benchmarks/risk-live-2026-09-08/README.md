# Published benchmark evidence

The public copy redacts actual net asset values and holdings counts (`netAssets`,
`newNetAssets`, and `holdingsCount`) to `null`. Corresponding values in narrative
reports are marked `[REDACTED]`. Original evidence remains local.

Timing observations, simulated transaction inputs, failures, and historical result
hashes are retained. Hashes describe the original observations, not the redacted
files. Do not use the public observations as a replayable market-data snapshot;
run the harness preflight and calibrate a new baseline in the configured local
environment.
