import { readFile, writeFile, rm } from 'node:fs/promises';

const file = 'src/wecom/cli.ts';
let source = await readFile(file, 'utf8');

function replaceOnce(before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (source.indexOf(before, index + before.length) >= 0) throw new Error(`Non-unique patch anchor: ${label}`);
  source = source.slice(0, index) + after + source.slice(index + before.length);
}

replaceOnce(
  `import {\n  buildWeComDoctorCardView,\n  buildWeComRecentTasksCardView,\n  recentTaskHint,\n} from './ui/doctor';`,
  `import {\n  buildWeComDoctorCardView,\n  buildWeComRecentTasksCardView,\n  recentTaskHint,\n  type WeComDependencyCheck,\n} from './ui/doctor';`,
  'doctor type import',
);

replaceOnce(
  `  const dependencies = [`,
  `  const dependencies: WeComDependencyCheck[] = [`,
  'doctor dependency annotation',
);

replaceOnce(
  `  ] as const;\n  await client.replyTemplateCard(`,
  `  ];\n  await client.replyTemplateCard(`,
  'doctor const assertion',
);

await writeFile(file, source);
await rm('scripts/apply-wecom-doctor-type-fixup.mjs', { force: true });
await rm('.github/workflows/wecom-doctor-type-fixup.yml', { force: true });
