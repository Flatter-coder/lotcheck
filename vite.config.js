
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Dev-only mirror of vercel.json's routing (everything except /api/* rewrites
// to /app.html in prod) so React routes like /verify are testable locally.
const spaRoutes = ['/verify', '/quote-check', '/admin', '/real', '/alert-confirm', '/msrp-alerts', '/live-price-index']
const devAppHtmlFallback = {
  name: 'dev-app-html-fallback',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const p = (req.url || '').split('?')[0]
      if (spaRoutes.some(r => p === r || p.startsWith(r + '/'))) req.url = '/app.html'
      next()
    })
  },
}

export default defineConfig({
  plugins: [react(), devAppHtmlFallback],
  build: {
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'app.html'),
      },
    },
  },
})
