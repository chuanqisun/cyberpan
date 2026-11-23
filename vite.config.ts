import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/orbital-strike/",
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
      },
    },
  },
});
