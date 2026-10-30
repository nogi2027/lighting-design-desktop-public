import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({ plugins:[react()], resolve:{alias:{'next/image':path.resolve('desktop/image.tsx')}}, build:{outDir:'dist',emptyOutDir:true} });
