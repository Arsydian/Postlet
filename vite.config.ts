/**
 * @file vite.config.ts
 * @description Vite configuration combining React, Tailwind CSS v4, and the Cloudflare Workers plugin
 * so local development runs directly against real Miniflare D1/R2 bindings and production outputs a
 * single Worker + static asset bundle.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    cloudflare(),
  ],
  build: {
    cssTarget: ["safari15.4", "ios15.4", "chrome108", "firefox101"],
  },
});
