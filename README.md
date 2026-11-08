# Codex / Claude Commit Message

A small VS Code extension that turns your current Git diff into an editable commit-message draft using your installed **Codex CLI** or **Claude Code**. It fills the existing Source Control message field. There are no runtime npm dependencies, webviews, stored API keys or extension telemetry.

Unofficial: not affiliated with or endorsed by OpenAI or Anthropic.

## Install and use

1. Install and sign in to [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) or [Claude Code](https://code.claude.com/docs/en/setup). Confirm the selected tool works in a terminal.
2. Install this extension from the Visual Studio Marketplace, or install a `.vsix` file with **Extensions: Install from VSIX…**.
3. Run **Codex / Claude: Select Commit Message Provider** to select Codex or Claude. Codex is the default.
4. Open a trusted Git repository and save your edits. Stage the changes you intend to commit.
5. Click the **extension icon** in the Source Control view's title bar, or run **Generate Commit Message with Codex / Claude** from the Command Palette. **Cancel** on the progress notification stops generation.
6. Review and edit the generated message, then commit using VS Code as usual.

Tested with desktop VS Code 1.145.2 and Git. Current CLIs are required for the restrictive execution flags; CLI contracts were checked against Codex 0.164.0 and Claude Code 2.1.312. The extension does not use either provider's VS Code chat panel or internal extension commands.

## Which changes are used?

- If there are staged changes, only the staged diff is used, including the staged portion of partially staged files.
- If nothing is staged, tracked unstaged changes are used. The progress notification tells you which source is active.
- New, untracked files must be staged first. Unsaved editor buffers are not part of Git's diff.
- Binary changes contribute Git's file-level metadata, not their binary contents.
- Empty diffs and unresolved conflicts are rejected with an explanation.
- In a workspace with multiple repositories, the Source Control action targets its own repository. The Command Palette action asks you to choose.

## Large changes

Diffs of any practical size work. A diff within `commitDraft.maxDiffBytes` (256 KB by default) is sent in full. A larger one is condensed to fit, never rejected, and the progress notification says so:

- An overview lists every changed file with its added and removed line counts.
- Patch excerpts share the remaining space fairly: small files stay whole, long ones are shortened with a marker saying how many lines were left out.
- Lock files, minified files, source maps and snapshots appear only in the overview, so they do not crowd out real code.
- The prompt tells the model the diff is condensed and asks it to describe the change as a whole without guessing at omitted details.

Git output is read up to 32 MB. Beyond that, the AI tool receives the file overview alone. In that case only, an edit during generation that keeps every file's line counts unchanged is not detected as a change.

The extension does not stage, commit, push or modify project files. Replacing an existing message requires confirmation. If your message, HEAD or selected diff changes during generation, the result opens as a separate unsaved draft instead of overwriting the input. Cancelling or failing a request preserves the current input. Only one request per repository can run at once.

On startup, generation waits for VS Code's Git initialization event before selecting a repository. This wait is cancellable and limited to 15 seconds. Disabling the extension or closing VS Code cancels running requests; the native deactivation hook awaits process and temporary-directory cleanup.

## Settings

Open Settings and search for `commitDraft`.

| Setting | Default | Purpose |
| --- | --- | --- |
| `commitDraft.provider` | `codex` | `codex` or `claude` |
| `commitDraft.codexPath` | `codex` | Executable name or absolute path, without arguments |
| `commitDraft.claudePath` | `claude` | Executable name or absolute path, without arguments |
| `commitDraft.codexModel` | empty | Optional model override |
| `commitDraft.claudeModel` | empty | Optional model override |
| `commitDraft.conventionalCommits` | `false` | Request `type(scope): description` format |
| `commitDraft.timeoutSeconds` | `120` | Timeout, from 10 to 600 seconds |
| `commitDraft.maxDiffBytes` | `262144` | Diff size sent in full, from 1 KB to 1 MB; larger diffs are condensed to fit |

Provider, executable, model and resource-limit settings are machine-scoped. A repository cannot supply its own executable through workspace settings. Blank model overrides use the CLI defaults; Codex user configuration is deliberately not loaded for these single-purpose requests.

Malformed settings are rejected before asking to replace your message or starting a provider. The error identifies the setting and offers **Open Settings**. A missing executable or a timeout offers the same button, opened at the setting that fixes it.

A full 256 KB prompt of generated TypeScript measured about 80,000 tokens with Codex and 150,000 with Claude (whose tokenizer counts code more densely), so the default fits Codex's 272,000-token and Claude's 1,000,000-token context windows. Larger values cost more usage per large commit. The 1 MB maximum suits Claude; Codex models run out of context well before it. A prompt over the model's context is rejected by the AI tool, and the extension shows that error.

On Windows, use the provider's native `.exe` installation and configure its full path if needed. `.cmd` and `.bat` shims are not supported because they require shell interpretation. On macOS/Linux, CLI executables installed on your PATH work, including the official npm-installed Codex launcher. Restart VS Code after installing a CLI if the extension cannot find it.

With WSL, SSH or Dev Containers, this extension runs in the workspace extension host: install and authenticate the CLI in that environment. Web-only and virtual repositories are not supported.

## Data and execution

Clicking Generate sends the chosen diff to the selected AI provider using your existing CLI authentication, account terms and usage limits. Review the staged changes before invoking it. The extension does not log the patch, store credentials, persist generated history or automatically switch providers.

When a provider fails, its own reason is shown, such as an unknown model or a sign-in problem. For Claude this is the `result` text of its JSON error response. Codex echoes the prompt on stderr, so only its `ERROR:` lines are read; the rest of stderr is kept as a short in-memory tail and never shown or logged. Reasons are reduced to one line of at most 300 characters.

Each provider runs in a new temporary directory. The prompt travels through stdin rather than command arguments. Codex runs non-interactively, ephemerally and read-only, with user configuration, shell tools, apps, plugins and web search disabled. Claude runs in safe mode, with built-in tools and MCP tools disabled and session persistence off. Managed organizational policies still apply. These flags do not change the provider's server-side retention policy.

Process execution uses Node's native asynchronous `spawn` with `shell: false`, bounded stdout, cancellation and a timeout. Cancellation stops the process group on macOS/Linux and uses Windows' native `taskkill /T /F` for the process tree on Windows. Cleanup finishes before the temporary directory is removed. Git external diff and text conversion drivers are disabled. Patch context is fixed to three lines; inherited `GIT_DIFF_OPTS` and `diff.interHunkContext` cannot expand the context sent to the provider. No proposed VS Code APIs are used, and runtime behavior uses no shell quoting, UI automation or private chat-extension APIs.

Diff selection, validation and insertion rules are deterministic. AI-generated wording is not guaranteed to be identical between requests, even with the same diff and model. The result always remains a draft for human review.

## Architecture

| Module | Responsibility |
| --- | --- |
| `extension.ts` | Native VS Code commands, repository selection, progress and safe insertion |
| `diff.ts` | Bounded, read-only Git snapshot collection and change fingerprinting |
| `condense.ts` | Fitting an oversized diff into the size budget |
| `providers.ts` | Documented Codex/Claude CLI invocation, response handling and error reasons |
| `errors.ts` | Errors that point at the setting which resolves them |
| `message.ts` | Prompt construction and commit-message validation |
| `process.ts` | Child-process lifecycle, output bounds, timeout and cancellation |
| `git-api.d.ts` | Minimal types for the built-in Git extension's version 1 API |

## Develop

Use Node.js 22+ and npm. From the extracted source directory:

```sh
npm ci
npm test
npm run test:integration
npm run package
```

All build and package output lives in `dist/`:

| Command | Output |
| --- | --- |
| `npm run build` | `dist/extension.js` and its development source map |
| `npm test` | Development build plus compiled unit-test modules in `dist/test/` |
| `npm run package` | Production bundle and `dist/codex-claude-commit-<version>.vsix` |

Each build clears `dist/` first, including any previously generated VSIX. `npm run clean` removes `dist/` without rebuilding. Packaging uses `vsce`'s native output-directory option and automatically takes the filename from the package name and version. Test modules and source maps are excluded from the VSIX.

The toolbar icon uses VS Code's native [`contributes.icons`](https://code.visualstudio.com/api/references/contribution-points#contributes.icons) registration. `resources/commit-draft.woff` contains one monochrome glyph (U+E001), with editable artwork in `resources/commit-draft.svg`; VS Code supplies theme colors and button states.

`npm test` type-checks, builds and runs tests against real temporary Git repositories and child processes. `test:integration` uses the official VS Code test runner with a disposable editor profile, two repositories and fake external AI executables; it makes no AI requests. On Linux without a display, run it with `xvfb-run -a npm run test:integration`. Set `VSCODE_EXECUTABLE_PATH` to an existing VS Code Electron binary (for example `/usr/share/code/code`, not the `code` CLI wrapper, which exits without running the tests) to avoid a test-editor download. When launching from inside a VS Code extension host, unset `ELECTRON_RUN_AS_NODE` first.

The test runner's optional VS Code download cache (`.vscode-test/`) and installed dependencies (`node_modules/`) are managed by their tools and retained across builds.

The executable fixtures for provider and extension-host tests require macOS/Linux; Windows child-process behavior needs native-platform validation. Runtime integration has been exercised on Linux with VS Code 1.145.2. Press F5 in this project to launch an Extension Development Host. Source maps are included in the development build; the VSIX contains the production bundle only.

TypeScript uses `module: "preserve"` and `moduleResolution: "bundler"` to match esbuild's source resolution. esbuild emits the CommonJS bundle expected by the extension host. The configuration passes both the pinned TypeScript 5.9.3 compiler and TypeScript 6.0.3 without deprecation suppression.

Validation on November 9, 2026: all 40 unit tests and 16 extension-host scenarios passed on Linux with VS Code 1.145.2, and a DevTools check confirmed the Generate button renders in the Source Control title bar. Real requests with Codex 0.164.0 and Claude Code 2.1.312 used a synthetic 2.2 MB, 104-file staged diff, condensed to 252 KB: both returned accurate messages, in 5 seconds (Codex, about 79,000 tokens) and 13 seconds (Claude, about 153,000 input tokens). Windows and macOS have not been exercised; the Windows process-tree implementation uses the documented native command.

## Publish

The extension is published under the `meirb` publisher, managed at the [Marketplace management page](https://marketplace.visualstudio.com/manage). Sign in once with an Azure DevOps personal access token that has the **Marketplace (Manage)** scope: `npx vsce login meirb`. Each release is `npx vsce publish`, which runs the production build first.

## Official references

- [VS Code Source Control API](https://code.visualstudio.com/api/extension-guides/scm-provider) and [built-in Git API](https://github.com/microsoft/vscode/blob/main/extensions/git/README.md)
- [VS Code command/menu contributions](https://code.visualstudio.com/api/references/contribution-points) and [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Claude programmatic use](https://code.claude.com/docs/en/headless) and [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [VS Code testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension) and [VSIX packaging](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [VS Code activation and deactivation](https://code.visualstudio.com/api/get-started/extension-anatomy) and [TypeScript bundler resolution](https://www.typescriptlang.org/docs/handbook/modules/reference.html#bundler)
- [Git diff options](https://git-scm.com/docs/git-diff) and [Git environment variables](https://git-scm.com/docs/git#_environment_variables)
- [Node child processes](https://nodejs.org/api/child_process.html) and [Windows process-tree termination](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)
