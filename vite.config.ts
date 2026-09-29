import { defineConfig } from 'vite'; import react from '@vitejs/plugin-react';
// Tauri's devUrl points at this exact address, so fail fast instead of silently moving to another port.
export default defineConfig({plugins:[react()], clearScreen:false, server:{host:'127.0.0.1', port:5173, strictPort:true}});
