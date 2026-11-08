/** An error the user resolves by changing the named `commitDraft` setting. */
export class SettingError extends Error {
  constructor(message: string, readonly setting: string) {
    super(message);
    this.name = 'SettingError';
  }
}
