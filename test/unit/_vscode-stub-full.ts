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
  static file(p: string): Uri {
    return new Uri(p);
  }
  static from(_: unknown): Uri {
    return new Uri('');
  }
  constructor(public readonly fsPath: string) {}
}
