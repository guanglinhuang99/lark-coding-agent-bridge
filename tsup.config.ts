import { defineConfig, type Options } from 'tsup';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export default defineConfig((options): Options[] => {
  const outDir = options.outDir ?? 'dist';
  return [
  {
    entry: {
      cli: 'src/cli/index.ts',
      wecom: 'src/wecom/cli.ts',
    },
    outDir,
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    clean: true,
    async onSuccess() {
      await mkdir(join(outDir, 'risk'), { recursive: true });
      await copyFile('src/business/risk/direct_bridge.py', join(outDir, 'risk/direct_bridge.py'));
    },
    sourcemap: false,
    splitting: false,
    dts: false,
    // Inline the Vite-built console (src/ui/generated/index.html) as a string.
    esbuildOptions(options) {
      options.loader = { ...options.loader, '.html': 'text' };
    },
  },
  {
    entry: { index: 'src/index.ts' },
    outDir,
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: false,
    splitting: false,
    dts: true,
  },
  ];
});
