//@ts-check
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

const success = watch ? 'Watch build succeeded' : 'Build succeeded';

function getTime() {
    const date = new Date();
    return `[${`${padZeroes(date.getHours())}:${padZeroes(date.getMinutes())}:${padZeroes(date.getSeconds())}`}] `;
}

function padZeroes(i) {
    return i.toString().padStart(2, '0');
}

const plugins = [{
    name: 'watch-plugin',
    setup(build) {
        build.onEnd(result => {
            if (result.errors.length === 0) {
                console.log(getTime() + success);
            }
        });
    },
}];

const ctx = await esbuild.context({
    // Entry points for the vscode extension and the language server
    entryPoints: ['src/extension/main.ts', 'src/language/main.ts'],
    outdir: 'out',
    bundle: true,
    target: "ES2017",
    // VSCode's extension host is still using cjs, so we need to transform the code
    format: 'cjs',
    // To prevent confusing node, we explicitly use the `.cjs` extension
    outExtension: {
        '.js': '.cjs'
    },
    loader: { '.ts': 'ts' },
    external: ['vscode'],
    platform: 'node',
    sourcemap: !minify,
    minify,
    plugins
});

// The preview webview is browser code, so it cannot share the context above: that one is
// platform:'node', format:'cjs' and renames its output to `.cjs` for the extension host.
const webviewCtx = await esbuild.context({
    entryPoints: ['src/webview/preview.ts', 'src/webview/preview.css'],
    outdir: 'out/webview',
    bundle: true,
    target: 'es2020',
    format: 'iife',
    platform: 'browser',
    loader: { '.ts': 'ts' },
    sourcemap: !minify,
    minify,
    plugins
});

if (watch) {
    await Promise.all([ctx.watch(), webviewCtx.watch()]);
} else {
    await Promise.all([ctx.rebuild(), webviewCtx.rebuild()]);
    ctx.dispose();
    webviewCtx.dispose();
}
