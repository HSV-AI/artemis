# Agent instructions

## Testing and completion

- Use Vitest for unit tests.
- Add unit tests for all new and changed application code.
- Mock Discord, PI, model-provider, and HTTP-fetch boundaries in unit tests. Model-provider and Docker integration tests are not required.
- Configure global statement, branch, function, and line coverage thresholds at 80% or higher.
- Provide and maintain an `npm run guardrail` command that runs all required checks, including the Vitest suite with coverage.
- Run the complete guardrail after making changes. Do not conclude that a task is complete or successful unless the guardrail passes.
- If the guardrail cannot be run or does not pass, report the task as incomplete and explain the blocker.

## Design documentation

- Before changing application behavior, review `design/README.md` and every relevant feature or protocol document.
- Every change must explicitly determine whether it affects observable behavior, configuration, persistence, security or privacy, model prompts, tools, external integrations, or deployment topology.
- Update the relevant design documentation in the same change whenever one of those areas changes.
- Every new protocol or major feature must have its own `design/<feature-or-protocol>.md` subdocument. This includes new user workflows, model protocols, tools or providers, authorization rules, persistence lifecycles, and deployment services.
- Link every new subdocument from `design/README.md`.
- Preserve `design/baseline.md` and `design/rebuild-guide.md` as records of the original design; later features belong in their authoritative feature or protocol subdocuments.
- Keep detailed contracts authoritative in their feature or protocol subdocument.
- Run `npm run check:design` and the complete `npm run guardrail` before concluding that a change is complete.
- A task is incomplete if its design impact has not been reviewed or required documentation is missing.
