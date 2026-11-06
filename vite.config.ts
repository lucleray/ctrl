import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"

const page = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    rollupOptions: {
      // The companion window (src/companion) is its own page.
      input: {
        main: page("src/renderer/index.html"),
        companion: page("src/renderer/companion/index.html"),
      },
    },
  },
})
