export function resolveUpstreamModel(requestedModel?: string): string {
  const defaultModel = process.env.DEFAULT_MODEL || 'gpt-4o';

  if (!requestedModel) {
    return defaultModel;
  }

  // Common aliases to remap to target RelationFlow model
  const mappings: Record<string, string> = {
    'gpt-6-astra': defaultModel,
    'gpt-6': defaultModel,
    'astra': defaultModel,
    'o3': defaultModel,
    'o1': defaultModel,
    'default': defaultModel,
    'relationflow-default': defaultModel,
    'relationflow-chat': defaultModel
  };

  // Custom mapping from env var (JSON format, e.g. {"gpt-6-astra": "claude-3-5-sonnet"})
  if (process.env.MODEL_MAP) {
    try {
      const custom = JSON.parse(process.env.MODEL_MAP);
      Object.assign(mappings, custom);
    } catch (e) {
      console.warn('[ModelResolver] Could not parse MODEL_MAP env variable as JSON:', e);
    }
  }

  const lookupKey = requestedModel.toLowerCase().trim();
  return mappings[lookupKey] || requestedModel;
}
