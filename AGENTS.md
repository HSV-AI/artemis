# Agent instructions

## Testing and completion

- Use Vitest for unit tests.
- Add unit tests for all new and changed application code.
- Mock Discord, PI, and Ollama boundaries in unit tests. Ollama and Docker integration tests are not required.
- Configure global statement, branch, function, and line coverage thresholds at 80% or higher.
- Provide and maintain an `npm run guardrail` command that runs all required checks, including the Vitest suite with coverage.
- Run the complete guardrail after making changes. Do not conclude that a task is complete or successful unless the guardrail passes.
- If the guardrail cannot be run or does not pass, report the task as incomplete and explain the blocker.

## Design documentation

- Before changing application behavior, review `design/README.md`, `design/baseline.md`, and every relevant feature or protocol document.
- Every change must explicitly determine whether it affects observable behavior, configuration, persistence, security or privacy, model prompts, tools, external integrations, or deployment topology.
- Update the relevant design documentation in the same change whenever one of those areas changes.
- Every new protocol or major feature must have its own `design/<feature-or-protocol>.md` subdocument. This includes new user workflows, model protocols, tools or providers, authorization rules, persistence lifecycles, and deployment services.
- Link every new subdocument from `design/README.md` and summarize and link it from `design/baseline.md`.
- Update `design/rebuild-guide.md` when a change alters behavior that a compatible implementation must reproduce.
- Keep detailed contracts authoritative in their feature or protocol subdocument. Keep `design/baseline.md` high level and avoid duplicating the complete contract there.
- Run `npm run check:design` and the complete `npm run guardrail` before concluding that a change is complete.
- A task is incomplete if its design impact has not been reviewed or required documentation is missing.
