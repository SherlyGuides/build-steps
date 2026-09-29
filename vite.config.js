import { defineConfig } from "vite";

// Relative asset paths so the same build works inside the Android app.
export default defineConfig({ base: "./", server: { port: 5199 } });
