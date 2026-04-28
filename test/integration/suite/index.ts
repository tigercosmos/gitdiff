import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 30000 });
  const testsRoot = __dirname;
  return new Promise((resolve, reject) => {
    for (const file of fs.readdirSync(testsRoot)) {
      if (file.endsWith('.test.js')) {
        mocha.addFile(path.join(testsRoot, file));
      }
    }
    try {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} tests failed.`));
        else resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}
