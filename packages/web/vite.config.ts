import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Kabadi Connect",
        short_name: "Kabadi",
        description: "Schedule recyclable pickups with your local kabadiwala",
        theme_color: "#1b7a43",
        background_color: "#f6faf7",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/config\.json$/],
        // API and map tiles always go to the network.
        runtimeCaching: [],
      },
    }),
  ],
});
