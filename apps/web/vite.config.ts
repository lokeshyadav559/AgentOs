import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "AgentOS",
        short_name: "AgentOS",
        description: "Personal AgentOS — agents work, you decide.",
        theme_color: "#111318",
        background_color: "#111318",
        display: "standalone",
        start_url: "/inbox",
        icons: [
          { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/hooks": "http://127.0.0.1:3000",
    },
  },
  build: {
    outDir: "dist",
  },
});
