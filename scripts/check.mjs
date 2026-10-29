import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { extname, join } from 'node:path';

const sourceDirectories = ['public', 'server', 'tests', 'scripts'];
const javaScriptExtensions = new Set(['.js', '.mjs']);

async function findJavaScriptFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findJavaScriptFiles(entryPath)));
    } else if (entry.isFile() && javaScriptExtensions.has(extname(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
}

const sourceFiles = ['server.mjs'];
for (const directory of sourceDirectories) {
  sourceFiles.push(...(await findJavaScriptFiles(directory)));
}

for (const sourceFile of sourceFiles.sort()) {
  execFileSync(process.execPath, ['--check', sourceFile], { stdio: 'inherit' });
}

console.log(`Syntax checked ${sourceFiles.length} JavaScript files.`);
