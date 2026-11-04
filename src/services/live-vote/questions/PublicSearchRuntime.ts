import { loadConfigLayers } from '../../../core/config/ConfigLayers';
import { createDeepSeekSearch, deepSeekSearchSettings } from './DeepSeekSearch';
import { createPublicDataRead } from './PublicDataClient';
import { PublicSearchEvidence } from './PublicSearchTools';

export type PublicSearchFactory = (signal: AbortSignal) => PublicSearchEvidence;

/** Channel model credentials remain separate; only the configured search provider is shared. */
export function createPublicSearchFactory(providerConfigPath: string, proxy?: string): PublicSearchFactory {
  const settings = deepSeekSearchSettings(loadConfigLayers({ configPath: providerConfigPath }));
  return signal => new PublicSearchEvidence(createPublicDataRead(signal, proxy), undefined,
    settings ? createDeepSeekSearch(settings, signal) : undefined);
}
