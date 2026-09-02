import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,              // allow external (LAN / tunnel) connections
    allowedHosts: true,      // accept any tunnel hostname (cloudflared/ngrok)
    proxy: {
      "/api": {
        target: "http://localhost:5001",
        changeOrigin: true,
      },
    },
  },
});
