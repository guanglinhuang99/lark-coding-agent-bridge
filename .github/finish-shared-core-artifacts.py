from pathlib import Path
p = Path('src/wecom/cli.ts')
s = p.read_text()
old = '''async function sendGeneratedArtifacts(
  frame: WsFrame,
  state: RunState,
  attachments: readonly NormalizedAttachment[],
): Promise<number> {'''
new = old.replace('): Promise<number> {', '  workspace: string,\n): Promise<number> {')
assert s.count(old) == 1
assert s.count('await sendGeneratedArtifacts(frame, state, attachments);') == 1
s = s.replace(old, new).replace('await sendGeneratedArtifacts(frame, state, attachments);', 'await sendGeneratedArtifacts(frame, state, attachments, sessionBinding.cwdRealpath);')
p.write_text(s.rstrip() + '\n')
