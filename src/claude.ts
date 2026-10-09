/** Claude models offered through the local Claude Code bridge. */
export const claudeModels = [
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: 'fastest' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'newer, thinks briefly before answering' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'smartest' },
] as const;
export type ClaudeModel = typeof claudeModels[number]['id'];
export const isClaudeModel = (value: unknown): value is ClaudeModel => claudeModels.some(model => model.id === value);
export const claudeModelLabel = (id: ClaudeModel) => claudeModels.find(model => model.id === id)?.label ?? id;
