import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/client.js'],
  bundle: true,
  outfile: 'public/bundle.js',
  format: 'iife',
  minify: true,
  sourcemap: false,
  target: ['es2019'],
  logLevel: 'info'
})

console.log('Built public/bundle.js')
