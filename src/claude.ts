/** Claude models offered through the local Claude Code bridge, fastest first. */
export const claudeModels = [
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: 'fastest' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', note: 'smarter, a little slower' },
] as const;
export type ClaudeModel = typeof claudeModels[number]['id'];
export const isClaudeModel = (value: unknown): value is ClaudeModel => claudeModels.some(model => model.id === value);
export const claudeModelLabel = (id: ClaudeModel) => claudeModels.find(model => model.id === id)?.label ?? id;
