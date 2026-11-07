import type { Event, Uri } from 'vscode';

// Minimal structural subset of the built-in Git extension's version 1 API.
// https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
export interface GitRepository {
  readonly rootUri: Uri;
  readonly inputBox: { value: string };
}

export interface GitAPI {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: Event<'uninitialized' | 'initialized'>;
  readonly git: { readonly path: string };
  readonly repositories: GitRepository[];
}

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}
