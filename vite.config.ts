import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({plugins:[react(),tailwindcss()],server:{port:1420,strictPort:true,host:'127.0.0.1',proxy:{'/api':{target:'http://127.0.0.1:3001',changeOrigin:false}}},clearScreen:false,envPrefix:['VITE_','TAURI_'],build:{target:'safari14'}});
