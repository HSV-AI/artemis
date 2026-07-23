# Agent instructions

## Testing and completion

- Use Vitest for unit tests.
- Add unit tests for all new and changed application code.
- Mock Discord, PI, and Ollama boundaries in unit tests. Ollama and Docker integration tests are not required.
- Configure global statement, branch, function, and line coverage thresholds at 80% or higher.
- Provide and maintain an `npm run guardrail` command that runs all required checks, including the Vitest suite with coverage.
- Run the complete guardrail after making changes. Do not conclude that a task is complete or successful unless the guardrail passes.
- If the guardrail cannot be run or does not pass, report the task as incomplete and explain the blocker.
