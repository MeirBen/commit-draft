# Contributing

Thanks for helping improve Commit Draft. Bug reports, ideas and pull requests are welcome through [GitHub issues](https://github.com/MeirBen/commit-draft/issues).

## Development setup

You need Node.js 22 or later, npm, Git and VS Code. The test fixtures use Unix executables, so run the tests on Linux or macOS.

```sh
git clone https://github.com/MeirBen/commit-draft.git
cd commit-draft
npm ci
npm test
```

Press **F5** in VS Code to launch an Extension Development Host with the extension loaded.

## Scripts

All build output goes to `dist/`, which every build clears first.

| Command | What it does |
| --- | --- |
| `npm run build` | Type-checks and bundles `dist/extension.js` with a source map |
| `npm test` | Builds, then runs the unit tests against real temporary Git repositories and child processes |
| `npm run test:integration` | Runs the extension inside VS Code with two repositories and fake AI executables; no AI requests are made |
| `npm run package` | Builds the production bundle and `dist/commit-draft-<version>.vsix` |
| `npm run clean` | Removes `dist/` |

### Integration tests

- On Linux without a display, run `xvfb-run -a npm run test:integration`.
- To skip downloading a test copy of VS Code, set `VSCODE_EXECUTABLE_PATH` to an installed VS Code Electron binary, such as `/usr/share/code/code`. Do not use the `code` command-line wrapper: it exits without running the tests.
- When running from inside a VS Code extension host (for example, from an AI agent in VS Code), unset `ELECTRON_RUN_AS_NODE` first.

## Project structure

| Path | Responsibility |
| --- | --- |
| `src/extension.ts` | Commands, repository selection, progress, settings validation and safe insertion |
| `src/diff.ts` | Read-only Git snapshot collection and change fingerprinting |
| `src/condense.ts` | Fitting an oversized diff into the size budget |
| `src/providers.ts` | Codex and Claude CLI invocation, response parsing and error reasons |
| `src/message.ts` | Prompt construction and commit-message validation |
| `src/process.ts` | Child-process lifecycle, output limits, timeout and cancellation |
| `src/errors.ts` | Errors that name the setting which resolves them |
| `src/git-api.d.ts` | Minimal types for the built-in Git extension's API (version 1) |
| `resources/commit-draft.svg` | Source artwork for the toolbar icon, compiled into `commit-draft.woff` (glyph U+E001) |

## Design principles

Keep these when changing behavior:

- **Never lose the user's work.** Confirm before replacing a message; if the diff, HEAD or message changes during generation, open the draft separately.
- **Never leak code.** Prompts go through stdin, never command-line arguments. Codex echoes its prompt on stderr, so stderr is kept only as a short in-memory tail, and only Codex's own `ERROR:` lines are shown.
- **No shell.** Processes are spawned with `shell: false`. Windows `.cmd` and `.bat` shims are rejected because they need shell interpretation.
- **Bounded everything.** Output size, timeouts and cancellation apply to every child process. Cancellation stops the whole process tree: by process group on macOS and Linux, and with `taskkill /T /F` on Windows.
- **Deterministic input.** Git's external diff and text-conversion drivers are disabled, and patch context is fixed at three lines whatever `GIT_DIFF_OPTS` or `diff.interHunkContext` say.
- **Stable APIs only.** Extensions using proposed VS Code APIs cannot be published to the Marketplace.

## Pull requests

- Keep each pull request focused on one change.
- Add or update tests, and make sure `npm test` and `npm run test:integration` pass.
- Update the README for user-visible changes.
- Write commit messages as [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, …). They decide the next version and the [CHANGELOG.md](CHANGELOG.md) entry.

## Releasing

Releases are automated by [publish.yml](.github/workflows/publish.yml) with [release-please](https://github.com/googleapis/release-please):

1. Every push to `main` runs `npm test`, then release-please opens or updates a release pull request that bumps `version` in `package.json` and adds the release to `CHANGELOG.md`. `feat:` bumps the minor version, `fix:` and `perf:` the patch version, and a breaking change (`feat!:`) the minor version while below 1.0. Other types, such as `chore:` and `docs:`, do not start a release.
2. Run `npm run test:integration`, then merge the release pull request.
3. The merge tags the release, creates the GitHub release, and publishes to the Marketplace with `npx vsce publish --oidc` through Marketplace trusted publishing. No personal access token is needed.

Alternatively, run `npm run package` and upload the `.vsix` on the [Marketplace management page](https://marketplace.visualstudio.com/manage).

## References

- [VS Code extension API](https://code.visualstudio.com/api), [Source Control API](https://code.visualstudio.com/api/extension-guides/scm-provider) and [built-in Git API](https://github.com/microsoft/vscode/blob/main/extensions/git/README.md)
- [Testing extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension) and [publishing extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Claude Code programmatic use](https://code.claude.com/docs/en/headless) and [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [git diff](https://git-scm.com/docs/git-diff) and [Node.js child processes](https://nodejs.org/api/child_process.html)
