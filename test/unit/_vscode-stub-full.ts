// Fuller stub of `vscode` for unit tests that import modules touching more of
// the API surface than just `workspace.getConfiguration`. We export only what
// changedFilesProvider needs to be `require()`d — without instantiating its
// class, no EventEmitter etc. are actually constructed at module load.
export const workspace = {
  getConfiguration(_section?: string) {
    return {
      get<T>(_key: string, fallback?: T): T | undefined {
        return fallback;
      },
    };
  },
};

export const commands = {
  async executeCommand(_command: string, ..._args: unknown[]): Promise<unknown> {
    return undefined;
  },
};

export const window = {
  showErrorMessage(_msg: string) {
    return Promise.resolve(undefined);
  },
  showWarningMessage(_msg: string) {
    return Promise.resolve(undefined);
  },
  showInformationMessage(_msg: string) {
    return Promise.resolve(undefined);
  },
};

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (cb: (e: T) => void) => {
    this.listeners.push(cb);
    return { dispose: () => {} };
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class Uri {
  readonly scheme: string;
  readonly path: string;
  readonly query: string;

  static file(p: string): Uri {
    return new Uri('file', p, '', p);
  }
  static from(parts: { scheme?: string; path?: string; query?: string }): Uri {
    return new Uri(parts.scheme ?? '', parts.path ?? '', parts.query ?? '');
  }
  constructor(
    schemeOrFsPath: string,
    path = '',
    query = '',
    public readonly fsPath = '',
  ) {
    this.scheme = path ? schemeOrFsPath : '';
    this.path = path || schemeOrFsPath;
    this.query = query;
  }
  toString(): string {
    const query = this.query ? `?${this.query}` : '';
    return `${this.scheme}:${this.path}${query}`;
  }
}

export class MarkdownString {
  value = '';
  isTrusted: boolean | undefined;

  constructor(value?: string, _supportThemeIcons?: boolean) {
    this.value = value ?? '';
  }

  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }

  appendText(value: string): MarkdownString {
    this.value += value;
    return this;
  }
}

export class Hover {
  constructor(public readonly contents: unknown) {}
}
