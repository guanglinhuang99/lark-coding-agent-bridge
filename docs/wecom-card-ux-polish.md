# WeCom Card UX Polish

This phase intentionally avoids expanding the proven three-button Home Card layout until real WeCom client validation confirms larger button sets are reliable and usable on mobile.

## Included

- Home Card keeps `stop` / `new` / `status` and advertises `/model`, `/reasoning`, `/resume`, and `/settings` as discoverable shortcuts.
- Session option rendering accepts an optional compact hint so runtime code can add reliable context such as age or recency when the data source exposes it.
- Result Card can display the effective model and reasoning level in addition to duration, tools, files, and thread.
- Settings Card points users back to `/menu` and the existing model/reasoning commands.
- Risk lifecycle compatibility is documented in code so a future shared-registry migration preserves `selected`, `invalid`, `missing`, `expired`, and `mismatch` semantics.

## Deliberately deferred

- No new Home Card buttons are added in this phase.
- No new callback action namespace is introduced.
- RiskSelectionTaskRegistry is not replaced.
- Runtime should only populate Result Card model/reasoning and Session hints when those values already exist reliably.
- Real WeCom smoke testing should validate card length, selector readability, and Markdown + Card message density before further visual expansion.
