import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_PORT = process.env.VITE_API_PORT || 3001;

export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_API_PORT": JSON.stringify(String(API_PORT)),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
