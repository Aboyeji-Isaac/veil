import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { ASSET_REGISTRY, getAssetIssuer } from '../assets';
import { fetchDashboardData, loadWalletAddress } from '../activity';
import { fetchPrice } from '../fetchPrice';
import { getNetwork } from '../network';

export const VOICE_SNAPSHOT_KEY = 'veil_voice_snapshot';
export const VOICE_KEYCHAIN_SERVICE = 'xyz.veil.wallet.voice.snapshot';
export const VOICE_KEYCHAIN_ACCESS_GROUP = 'group.xyz.veil.wallet.voice';

export type VoiceAssetQuote = {
  code: string;
  issuer: string | null;
  priceUsd: number | null;
};

export type VoiceSnapshot = {
  version: 1;
  updatedAt: string;
  network: 'testnet' | 'mainnet';
  xlmBalance: string;
  prices: VoiceAssetQuote[];
};

export type VoiceAssetResolution =
  | { ok: true; code: string; issuer: string | null }
  | { ok: false; reason: 'unverified' | 'invalid-xlm-issuer' | 'unavailable' };

/**
 * Voice surfaces may name assets, but they never get to identify an issued
 * asset by code alone. The resolver accepts only native XLM or the exact
 * code+issuer pair from Veil's verified registry for the active network.
 */
export function resolveVoiceAsset(
  code: string,
  issuer: string | null | undefined,
  network: 'testnet' | 'mainnet',
): VoiceAssetResolution {
  const upper = code.trim().toUpperCase();
  if (!upper) return { ok: false, reason: 'unavailable' };

  if (upper === 'XLM') {
    return issuer?.trim()
      ? { ok: false, reason: 'invalid-xlm-issuer' }
      : { ok: true, code: 'XLM', issuer: null };
  }

  const registered = ASSET_REGISTRY[upper];
  if (!registered) return { ok: false, reason: 'unverified' };

  const canonicalIssuer = getAssetIssuer(registered.code, network);
  if (!canonicalIssuer) return { ok: false, reason: 'unavailable' };

  if (issuer?.trim() && issuer.trim() !== canonicalIssuer) {
    return { ok: false, reason: 'unverified' };
  }

  return { ok: true, code: registered.code, issuer: canonicalIssuer };
}

export function resolveSnapshotPrice(
  snapshot: VoiceSnapshot,
  code: string,
  issuer?: string | null,
): VoiceAssetQuote | null {
  const resolved = resolveVoiceAsset(code, issuer, snapshot.network);
  if (!resolved.ok) return null;
  return (
    snapshot.prices.find(
      (entry) =>
        entry.code === resolved.code &&
        (entry.issuer ?? null) === (resolved.issuer ?? null),
    ) ?? null
  );
}

/**
 * Build the voice snapshot using the exact read paths already used by the
 * mobile UI. The snapshot contains only public/read-only values: no seed,
 * signer secret, passkey material, transaction XDR, or RPC URL.
 */
export async function buildVoiceSnapshot(): Promise<VoiceSnapshot> {
  const network = getNetwork();
  const address = await loadWalletAddress();

  let xlmBalance = '0';
  if (address) {
    try {
      xlmBalance = (await fetchDashboardData(address)).xlmBalance;
    } catch {
      // A voice query should degrade to a clean zero/unavailable snapshot,
      // never expose the underlying network/RPC error.
      xlmBalance = '0';
    }
  }

  const requested: Array<{ code: string; issuer: string | null }> = [
    { code: 'XLM', issuer: null },
  ];
  for (const asset of Object.values(ASSET_REGISTRY)) {
    const issuer = getAssetIssuer(asset.code, network.name);
    if (!issuer) continue;
    if (!requested.some((entry) => entry.code === asset.code && entry.issuer === issuer)) {
      requested.push({ code: asset.code, issuer });
    }
  }

  const prices = await Promise.all(
    requested.map(async ({ code, issuer }): Promise<VoiceAssetQuote> => ({
      code,
      issuer,
      priceUsd: await fetchPrice(code, issuer),
    })),
  );

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    network: network.name,
    xlmBalance,
    prices,
  };
}

/**
 * Refresh the iOS keychain snapshot shared with the read-only App Intents
 * extension. On other platforms there is no iOS extension, so this is a no-op.
 */
export async function refreshVoiceSnapshot(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const snapshot = await buildVoiceSnapshot();
  await SecureStore.setItemAsync(VOICE_SNAPSHOT_KEY, JSON.stringify(snapshot), {
    accessGroup: VOICE_KEYCHAIN_ACCESS_GROUP,
    keychainService: VOICE_KEYCHAIN_SERVICE,
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}
