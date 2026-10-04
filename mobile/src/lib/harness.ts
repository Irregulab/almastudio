import type { HarnessKind } from '@almastudio/protocol'

export const HARNESS_LABEL: Record<HarnessKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  shell: 'Terminal',
}

export const HARNESS_ICON: Record<HarnessKind, 'sparkles' | 'code-slash' | 'cube-outline' | 'terminal'> = {
  claude: 'sparkles',
  codex: 'code-slash',
  opencode: 'cube-outline',
  shell: 'terminal',
}
