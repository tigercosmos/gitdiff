// Minimal stub of the bits of `vscode` that GitService touches at runtime.
export const workspace = {
  getConfiguration(_section?: string) {
    return {
      get<T>(_key: string, fallback?: T): T | undefined {
        return fallback;
      },
    };
  },
};
