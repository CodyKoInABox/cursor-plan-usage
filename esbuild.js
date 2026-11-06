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

  const wasmSrc = require.resolve(
    'node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm'
  );
  fs.copyFileSync(
    wasmSrc,
    path.join(__dirname, 'out', 'node-sqlite3-wasm.wasm')
  );
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

/**
 * The sidebar script runs in a webview, so it is an IIFE with no imports left.
 * It bundles the TS helpers from billing.ts and projection.ts.
 * @type {import('esbuild').BuildOptions}
 */
const viewBuildOptions = {
  entryPoints: ['src/media/view.js'],
  bundle: true,
  outfile: 'out/media/view.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: !watch,
  logLevel: 'info',
};

async function main() {
  copyStatic();

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    const viewCtx = await esbuild.context(viewBuildOptions);
    await ctx.watch();
    await viewCtx.watch();
    console.log('watching…');
  } else {
    await esbuild.build(buildOptions);
    await esbuild.build(viewBuildOptions);
    console.log('build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
