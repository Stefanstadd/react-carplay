import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill'

export default defineConfig({
  main: {
  plugins: [externalizeDepsPlugin({ exclude: ['node-carplay'] })],
  build: {
    rollupOptions: {
      // dbus-next is optional + Linux-only.  It contains a try/catch require
      // for 'x11' (rarely-used auth) that rollup eagerly resolves when
      // bundled — externalizing both lets the runtime try/catch do its job.
      external: ['socketcan', 'socketmost', 'dbus-next', 'x11']
    }
  }
},
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        stream: "stream-browserify",
        Buffer: "buffer",
      }
    },
    optimizeDeps: {
      esbuildOptions: {
        define: {
          global: 'globalThis'
        },
        plugins: [
          NodeGlobalsPolyfillPlugin({
            process: true,
            buffer: true
          })
        ]
      }
    },
    plugins: [react()]
  }
})
