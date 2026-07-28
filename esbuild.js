const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

function copyStatic() {
  const mediaOut = path.join(__dirname, 'out', 'media');
  fs.mkdirSync(mediaOut, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, 'src', 'media', 'view.css'),
    path.join(mediaOut, 'view.css')
  );
  fs.copyFileSync(
    path.join(__dirname, 'src', 'media', 'view.js'),
    path.join(mediaOut, 'view.js')
  );

  const wasmSrc = require.resolve('sql.js/dist/sql-wasm.wasm');
  fs.copyFileSync(wasmSrc, path.join(__dirname, 'out', 'sql-wasm.wasm'));
}

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

async function main() {
  copyStatic();

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('watching…');
  } else {
    await esbuild.build(buildOptions);
    console.log('build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
