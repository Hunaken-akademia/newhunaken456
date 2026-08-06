WAKE patch v7

Changes:
- Moved the attack-resistance section to between Tenkai Rehearsal and Nige Simulation.
- Added the Kimarite Rate reference table above attack resistance.
- Kimarite Rate supports the existing 6-month / 1-year selector.
- Kimarite Rate is display-only and is not passed into AI evaluation, scenario logic, or ticket selection.
- Attack resistance remains fixed to the latest 1 year.

Replace:
src/App.jsx

Validation:
- JSX syntax checked with the TypeScript parser: 0 diagnostics.
- Full Vite build could not run in this environment because the internal npm registry does not provide playwright.
